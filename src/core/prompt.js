'use strict';

/**
 * 系统提示与安全审查（与桌面版 main.js 中的逻辑一一对应）。
 */

const { streamChat } = require('./llm');
const oauth = require('./oauth');

const REVIEW_TIMEOUT = 25000;

const REVIEW_SYSTEM = [
  '你是 DgxayCode 的本机操作安全审查模型。AI 助手在获得用户授权前，由你判断一次操作是否可能伤害用户的电脑或泄露数据。',
  '只输出 JSON，不要代码块：{"decision":"allow","reason":"..."} 或 {"decision":"review","reason":"..."}',
  'allow 适用于：读取与任务直接相关的文件、在工作空间内写入普通文本文件、查看目录、执行只读查询、访问公开文档。',
  'review 适用于：删除或覆盖重要文件、修改工作空间外的系统/用户目录、安装/卸载/提权/服务/批量脚本、访问 .ssh/.env/密钥/浏览器数据、上传本地数据到外部、命令或目标不明确、可能不可逆。',
  '不确定时选择 review。理由用简体中文，不超过 60 字。'
].join('\n');

function systemPromptFor({ mode, permission, workspace, customPrompt, skill }) {
  const parts = [];
  parts.push(
    '你是 DgxayCode 命令行版内置的 AI 助手。回答使用简体中文（除非用户使用其他语言），结构清晰，尽量简洁，合理使用 Markdown。'
  );
  if (skill?.content) {
    parts.push(`【本对话启用的技能：${skill.name}】\n${skill.content}`);
  }
  if (customPrompt && String(customPrompt).trim()) {
    parts.push(`用户自定义指令：\n${String(customPrompt).trim()}`);
  }

  if (mode !== 'work') {
    parts.push('当前为「对话模式」：不提供文件系统与终端工具，直接通过文字回答用户。');
    if (permission !== 'none') {
      parts.push(
        '如果用户明确要求安装 MCP server，可以调用 install_mcp_server 保存启动配置，并提示用户运行 dgxay mcp start 启动。'
      );
    }
    return parts.join('\n\n');
  }

  parts.push(`当前为「工作模式」。工作空间目录：${workspace || '（尚未选择）'}。`);
  if (permission === 'none') {
    parts.push(
      '权限级别：无权限。你只能以只读方式访问工作空间内的文件，禁止修改/创建/删除文件，禁止联网，禁止执行命令。' +
        '如果用户要求写入文件、联网或执行命令，请说明需要切换到「普通权限」「自动审查」或「完全权限」。'
    );
  } else if (permission === 'normal') {
    parts.push(
      '权限级别：普通权限。你拥有全部能力：可以读写任意文件、执行终端命令、访问网络。' +
        '但每一次工具调用或终端命令都需要用户在终端确认后才能执行；如果用户拒绝，不要重试，改用已经获得的信息回答。'
    );
  } else if (permission === 'auto') {
    parts.push(
      '权限级别：自动审查。你拥有全部能力：可以读写任意文件、执行终端命令、访问网络。' +
        '每一次操作会先由自动审查模型判断风险，安全操作自动放行，可疑操作转交用户确认；如果被拒绝，不要重试。'
    );
  } else {
    parts.push(
      '权限级别：完全权限。你可以执行终端命令、访问任意文件、无限制联网，不再经过审查或询问。执行破坏性操作前请先向用户确认。'
    );
  }

  parts.push(
    '安装 MCP：如果用户明确要求安装 MCP server，调用 install_mcp_server 保存启动配置，完成后提示用户运行 dgxay mcp start 或在 /mcp 面板中启动。不要伪造安装结果。'
  );

  if (workspace) {
    parts.push(
      [
        '工作模式规则：',
        '1. 需要查看或修改文件时，必须调用工具，不要凭空假设文件内容；修改前先 read_file。',
        '2. 所有生成的文件必须保存到工作空间内，优先使用相对路径。',
        '3. 完成任务后用简短的中文总结你创建/修改了哪些文件。',
        '',
        '【任务执行纪律】',
        '• 收到目标后先拆成可执行步骤，然后立刻调用工具开始执行。禁止只输出计划、承诺或“接下来我会…”。',
        '• 在任务真正完成之前不得停止，也不要等待用户说“继续”。每次工具返回后自动进入下一步，直到所有步骤都完成。',
        '• 需要多次读写、多个文件或多个命令时，连续执行完再结束；不要做完一步就交差。',
        '• 工具报错时先分析原因并换一种方式重试；只有缺少必要信息、权限被拒绝或任务确实无法继续时才可停下，并说明具体阻塞点。',
        '• 结束前做一次验证：重新读取关键文件、检查命令输出或运行必要测试。',
        '• 全部完成后，再用简短列表报告已完成内容与验证结果。未完成时禁止输出结束语或“如需继续请告诉我”。'
      ].join('\n')
    );
  } else {
    parts.push('尚未选择工作空间时，请不要调用任何文件工具，提示用户先用 /cd 选择工作目录。');
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
    copy.content = `${copy.content.slice(0, 1200)}…（共 ${copy.content.length} 字符）`;
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
    return { decision: 'review', reason: '尚未配置自动审查模型，需要你确认', reviewer: null, modelId: null };
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
            `操作类型：${kind === 'terminal' ? '终端命令' : '工具调用'}`,
            `操作名称：${name}`,
            command ? `命令：${command}` : '',
            `工作空间：${workspace || '（未选择）'}`,
            args ? `参数：${summarizeArgs(args)}` : '',
            '请判断这次操作是否安全。'
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
    let reason = text.slice(0, 160) || '审查模型未给出结论';
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
      reason: `自动审查失败：${err.message}`,
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
  if (!provider || !targetModel) throw new Error('没有可用模型，无法压缩上下文');

  const history = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim()
  );
  if (!history.length) return { ok: true, summary: '', usage: null };

  const transcript = history
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
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
        content: '你是上下文压缩器。把长对话压缩成一份可供后续继续工作的摘要。只输出摘要正文，不要寒暄，不要代码块围栏。'
      },
      {
        role: 'user',
        content:
          '请压缩下面的对话。必须保留：用户目标与偏好、关键事实与数字、已做出的决定、涉及的文件路径与代码位置、未完成事项、重要工具结果。删除寒暄、重复解释和无关内容。用简体中文输出，控制在 800 字以内。\n\n' +
          transcript
      }
    ],
    stream: false,
    temperature: 0.2,
    maxTokens: Math.min(2048, Number(config.chat?.maxTokens) || 2048)
  });

  const summary = String(result.content || '').trim();
  if (!summary) throw new Error('模型没有返回摘要，请稍后重试');
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
