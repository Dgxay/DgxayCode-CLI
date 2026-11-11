'use strict';

/**
 * 系统提示与安全审查（与桌面版 main.js 中的逻辑一一对应）。
 */

const { streamChat } = require('./llm');
const oauth = require('./oauth');

const REVIEW_TIMEOUT = 25000;

const REVIEW_SYSTEM = [
  'You are the local-operation safety reviewer for DgxayCode. Before the AI assistant is allowed to act on the user\'s machine, you decide whether an operation could harm the computer or leak data.',
  'Output JSON only, no code fences: {"decision":"allow","reason":"..."} or {"decision":"review","reason":"..."}',
  'allow: reading files directly relevant to the task, writing ordinary text files inside the workspace, listing directories, read-only queries, fetching public documentation.',
  'review: deleting or overwriting important files, touching system or user directories outside the workspace, installing/uninstalling/elevating/services/bulk scripts, reading .ssh/.env/keys/browser data, uploading local data, ambiguous commands or targets, anything irreversible.',
  'When unsure, choose review. Keep the reason under 60 characters.'
].join('\n');

function systemPromptFor({ mode, permission, workspace, customPrompt, skill }) {
  const parts = [];
  parts.push(
    'You are the AI assistant built into the DgxayCode command-line tool. Always answer in English unless the user writes in another language. Be clear and concise, and use Markdown where it helps.'
  );
  if (skill?.content) {
    parts.push(`[Skill enabled for this conversation: ${skill.name}]\n${skill.content}`);
  }
  if (customPrompt && String(customPrompt).trim()) {
    parts.push(`User instructions:\n${String(customPrompt).trim()}`);
  }

  if (mode !== 'work') {
    parts.push('You are in "chat mode": no filesystem or shell tools are available. Answer in prose.');
    if (permission !== 'none') {
      parts.push(
        'If the user explicitly asks to install an MCP server you may call install_mcp_server to save the launch configuration, then tell them to run dgxay mcp start.'
      );
    }
    return parts.join('\n\n');
  }

  parts.push(`You are in "work mode". Workspace directory: ${workspace || '(not selected)'}.`);
  if (permission === 'none') {
    parts.push(
      'Permission level: none. You may only read files inside the workspace. Writing, creating, deleting, network access and shell commands are all forbidden. ' +
        'If the user asks for any of those, explain that they need to switch to normal, auto-review or full permission.'
    );
  } else if (permission === 'normal') {
    parts.push(
      'Permission level: normal. You have every capability: read/write any file, run shell commands, access the network. ' +
        'Every tool call requires explicit user approval in the terminal first; if the user declines, do not retry — answer with what you already know.'
    );
  } else if (permission === 'auto') {
    parts.push(
      'Permission level: auto review. You have every capability: read/write any file, run shell commands, access the network. ' +
        'Each operation is first judged by the reviewer model; safe ones run automatically and suspicious ones are handed to the user. If declined, do not retry.'
    );
  } else {
    parts.push(
      'Permission level: full access. You may run shell commands, touch any file and access the network without review. Confirm destructive actions with the user first.'
    );
  }

  parts.push(
    'MCP: if the user explicitly asks to install an MCP server, call install_mcp_server to save it, then tell them to run dgxay mcp start (or use /mcp). Never fabricate the result.'
  );

  if (workspace) {
    parts.push(
      [
        'Work-mode rules:',
        '1. Whenever you need to inspect or change files, call a tool — never assume file contents. Read before you write.',
        '2. Save every generated file inside the workspace, preferring relative paths.',
        '3. When the task is done, summarize in a short list which files you created or modified.',
        '',
        '[Execution discipline]',
        '• Break the goal into actionable steps and start calling tools immediately. Do not output only a plan or a promise ("I will..." / "Next I will...").',
        '• Do not stop until the task is genuinely finished, and do not wait for the user to say "continue". After each tool result, proceed to the next step automatically.',
        '• When the task needs several reads, writes or commands, run them all before wrapping up; do not stop after one step.',
        '• On tool errors, analyse the cause and retry differently. Only stop when information is missing, permission was denied, or the task truly cannot continue — and state the exact blocker.',
        '• Verify before finishing: re-read key files, check command output, or run the relevant tests.',
        '• Then report what was done and how it was verified. Never end with "let me know if you want me to continue".'
      ].join('\n')
    );
  } else {
    parts.push('No workspace is selected: do not call file tools. Ask the user to pick a directory with /cd.');
  }
  return parts.join('\n\n');
}

async function resolveProviderAuth(provider) {
  if (provider?.authMode === 'oauth' && provider.oauthProvider) {
    const token = await oauth.getAccessToken(provider.oauthProvider);
    return { apiKey: token, authType: 'oauth' };
  }
  return { apiKey: provider?.apiKey || '', authType: 'apiKey' };
}

function summarizeArgs(args) {
  if (args == null) return '';
  if (typeof args !== 'object') return String(args).slice(0, 1800);
  const copy = { ...args };
  if (typeof copy.content === 'string' && copy.content.length > 1200) {
    copy.content = `${copy.content.slice(0, 1200)}… (${copy.content.length} chars total)`;
  }
  let text = JSON.stringify(copy);
  if (text.length > 2000) text = `${text.slice(0, 2000)}…`;
  return text;
}

/** 审查模型解析：优先当前供应商，未配置时回退到 providers[0]（默认供应商） */
function resolveReviewer(config, providerId) {
  const usable = (provider) =>
    Boolean(
      provider?.reviewModelId &&
        Array.isArray(provider.models) &&
        provider.models.some((model) => model.id === provider.reviewModelId)
    );
  const own = (config.providers || []).find((provider) => provider.id === providerId);
  if (usable(own)) return { provider: own, modelId: own.reviewModelId, source: 'own' };
  const fallback = (config.providers || [])[0];
  if (usable(fallback)) return { provider: fallback, modelId: fallback.reviewModelId, source: 'default' };
  return null;
}

function hasReviewModel(config) {
  return Boolean(resolveReviewer(config, config?.activeProviderId));
}

async function reviewOperation({ config, providerId, kind, name, args, command, workspace }) {
  const reviewer = resolveReviewer(config, providerId);
  if (!reviewer) {
    return { decision: 'review', reason: 'No review model configured — asking you instead', reviewer: null, modelId: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT);
  try {
    const reviewerAuth = await resolveProviderAuth(reviewer.provider);
    const result = await streamChat({
      protocol: reviewer.provider.protocol || 'openai',
      baseUrl: reviewer.provider.baseUrl,
      apiKey: reviewerAuth.apiKey,
      authType: reviewerAuth.authType,
      model: reviewer.modelId,
      messages: [
        { role: 'system', content: REVIEW_SYSTEM },
        {
          role: 'user',
          content: [
            `Operation type: ${kind === 'terminal' ? 'shell command' : 'tool call'}`,
            `Operation: ${name}`,
            command ? `Command: ${command}` : '',
            `Workspace: ${workspace || '(none)'}`,
            args ? `Arguments: ${summarizeArgs(args)}` : '',
            'Is this operation safe?'
          ]
            .filter(Boolean)
            .join('\n')
        }
      ],
      stream: false,
      temperature: 0,
      maxTokens: 320,
      signal: controller.signal
    });

    const text = String(result.content || '').trim();
    let decision = 'review';
    let reason = text.slice(0, 160) || 'The reviewer gave no verdict';
    const left = text.indexOf('{');
    const right = text.lastIndexOf('}');
    if (left !== -1 && right > left) {
      try {
        const parsed = JSON.parse(text.slice(left, right + 1));
        if (String(parsed.decision || '').toLowerCase() === 'allow') decision = 'allow';
        if (parsed.reason) reason = String(parsed.reason).slice(0, 200);
      } catch {
        /* keep review */
      }
    }
    return {
      decision,
      reason,
      reviewer: reviewer.provider.name,
      modelId: reviewer.modelId,
      source: reviewer.source
    };
  } catch (err) {
    // 超时、网络失败或返回无法解析时一律按“可疑”处理，转交用户确认
    return {
      decision: 'review',
      reason: `Auto-review failed: ${err.message}`,
      reviewer: reviewer.provider.name,
      modelId: reviewer.modelId,
      source: reviewer.source
    };
  } finally {
    clearTimeout(timer);
  }
}

function looksUnfinishedWork(result) {
  const text = String(result?.content || '').trim();
  if (result?.finishReason === 'length') return true;
  if (!text) return true;
  const tail = text.slice(-520);
  return /(我(将|会|马上|这就|现在)(继续|开始|去|来|处理|执行|写入|创建|生成|读取|检查|整理)|接下来(我)?(会|将|继续|需要)|下一步(我)?(会|将)|稍后(会|将|再)|let me (now )?(proceed|continue|start|check)|i(?:'|’)ll (now )?(proceed|continue|start|check|write)|next,? i (?:will|'ll))/i.test(
    tail
  );
}

/** 上下文压缩（/compress）：用一条摘要替换全部历史，有损且不可撤销 */
async function compressMessages({ config, providerId, modelId, messages }) {
  const provider = (config.providers || []).find((item) => item.id === providerId) || (config.providers || [])[0];
  const targetModel = modelId || provider?.models?.[0]?.id;
  if (!provider || !targetModel) throw new Error('No model available to compress the context');

  const history = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim()
  );
  if (!history.length) return { ok: true, summary: '', usage: null };

  const transcript = history
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n')
    .slice(-150000);

  const providerAuth = await resolveProviderAuth(provider);
  const result = await streamChat({
    protocol: provider.protocol || 'openai',
    baseUrl: provider.baseUrl,
    apiKey: providerAuth.apiKey,
    authType: providerAuth.authType,
    model: targetModel,
    messages: [
      {
        role: 'system',
        content: 'You compress conversations into a summary that lets work continue. Output only the summary body: no greeting, no code fences.'
      },
      {
        role: 'user',
        content:
          'Compress the conversation below. Keep: user goals and preferences, key facts and numbers, decisions made, file paths and code locations, open items, and important tool results. Drop greetings, repetition and noise. Write in English, at most 800 words.\n\n' +
          transcript
      }
    ],
    stream: false,
    temperature: 0.2,
    maxTokens: Math.min(2048, Number(config.chat?.maxTokens) || 2048)
  });

  const summary = String(result.content || '').trim();
  if (!summary) throw new Error('The model returned no summary, try again later');
  return { ok: true, summary, usage: result.usage || null };
}

module.exports = {
  REVIEW_SYSTEM,
  REVIEW_TIMEOUT,
  systemPromptFor,
  resolveProviderAuth,
  summarizeArgs,
  resolveReviewer,
  hasReviewModel,
  reviewOperation,
  looksUnfinishedWork,
  compressMessages
};
