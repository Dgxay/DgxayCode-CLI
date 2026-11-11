'use strict';

/**
 * run：一次性把提示词交给模型并打印结果。
 *
 *   dgxay run -p "帮我整理这个目录" -C ./project -m work --permission auto
 *   dgxay run -p "生成接口文档" -o json
 *
 * 权限提示：带工具的工作模式如果遇到需要确认的操作，单次运行默认拒绝；
 * 明确加 --yes 才会自动放行（只对本进程生效，不写入配置）。
 */

const print = require('../cli/print');
const { parseArgs } = require('../cli/args');
const { askApproval } = require('../cli/approval');
const settings = require('../services/settings');
const { runAgent } = require('../core/agent');
const { StreamRenderer } = require('../cli/render');
const { resolveChatArg } = require('./_shared');

const options = [
  { name: 'prompt', alias: 'p', type: 'string', valueName: 'text', desc: 'Prompt' },
  { name: 'mode', alias: 'm', type: 'string', valueName: 'mode', desc: 'chat / work (default chat)' },
  { name: 'permission', type: 'string', valueName: 'level', desc: 'none / normal / auto / full' },
  { name: 'workspace', alias: 'C', type: 'string', valueName: 'dir', desc: 'Workspace directory' },
  { name: 'provider', type: 'string', valueName: 'name', desc: 'Provider id or name' },
  { name: 'model', type: 'string', valueName: 'id', desc: 'Model id' },
  { name: 'skill', type: 'string', valueName: 'name', desc: 'Skill to enable' },
  { name: 'resume', alias: 'r', type: 'string', valueName: 'id|index', desc: 'Continue a conversation by index or id' },
  { name: 'continue', alias: 'c', type: 'boolean', desc: 'Continue the most recent conversation' },
  { name: 'output', alias: 'o', type: 'string', valueName: 'text|json', desc: 'Output format, default text' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: 'Auto-approve permission requests (dangerous)' },
  { name: 'quiet', alias: 'q', type: 'boolean', desc: 'Only print the reply text' }
];

async function run({ argv, globalOptions, runtime }) {
  const { options: opts, positionals } = parseArgs(argv, options);
  const prompt = String(opts.prompt || positionals.join(' ') || runtime.prompt || '').trim();
  if (!prompt) {
    throw Object.assign(new Error('Missing prompt: use -p "..." or pass the question directly'), { userError: true });
  }

  const config = settings.readConfig();
  if (!config.providers?.length) {
    throw Object.assign(new Error('No provider configured. Run dgxay config init first'), { userError: true });
  }

  const mode = String(opts.mode || runtime.mode || 'chat') === 'work' ? 'work' : 'chat';
  const permission = String(opts.permission || runtime.permission || settings.currentPermission(config));
  const workspace = opts.workspace || runtime.workspace || config.work?.workspace || process.cwd();
  const skill = String(opts.skill || runtime.skill || '');
  const outputFormat = String(opts.output || runtime.output || 'text');
  // JSON 输出时把正文让给最终的结构化结果，避免混入流式文本
  const jsonMode = outputFormat === 'json';
  const quiet = Boolean(opts.quiet) || jsonMode;
  // 正文一旦输出就无法回退：提示词只在安静/JSON 模式之外显示
  if (!quiet) print.write(prompt);

  const chat = resolveChatArg(opts, runtime);
  const history = chat ? require('../core/sessions').buildHistory(chat) : [];
  // 关键：本次提问必须进入消息列表，否则模型只会看到历史（甚至只看得到 system）
  const messages = [...history, { role: 'user', content: prompt }];

  const renderer = new StreamRenderer({
    output: process.stdout,
    redraw: Boolean(process.stdout.isTTY) && !quiet
  });
  const startedAt = Date.now();
  const result = await runAgent({
    config,
    messages,
    providerId: opts.provider || runtime.provider,
    modelId: opts.model || runtime.model,
    mode,
    permission,
    workspace,
    skill,
    askUser: async (request) => {
      if (opts.yes || runtime.yes) return true;
      return askApproval(request);
    },
    onEvent: (event) => {
      if (jsonMode) {
        // JSON 模式只保留需要人工介入的过程提示（授权、审查），正文交给最终 JSON
        if (!['review', 'review-start', 'waiting', 'file'].includes(event.type)) return;
        if (event.type === 'tool') return;
      }
      if (opts.quiet && !['delta', 'done', 'error', 'aborted'].includes(event.type)) return;
      renderer.handle(event);
    }
  });

  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: result.ok,
          aborted: Boolean(result.aborted),
          text: result.text,
          reasoning: result.reasoning,
          usage: result.usage,
          toolLog: result.toolLog,
          files: result.files,
          error: result.error || null,
          elapsedMs: Date.now() - startedAt
        },
        null,
        2
      )}\n`
    );
  }

  persistChat({ chat, prompt, mode, permission, result, history });

  if (result.error) return 1;
  if (result.aborted) return 130;
  return 0;
}

/**
 * 单次运行的会话落库（与桌面版一致：每次提问都会出现在历史里）。
 * 失败不影响命令结果，只在 debug 模式下提示。
 */
function persistChat({ chat, prompt, mode, permission, result, history }) {
  const sessions = require('../core/sessions');
  try {
    const target =
      chat ||
      sessions.createChat({
        mode,
        skill: ''
      });
    target.mode = mode;
    target.messages.push({
      role: 'user',
      content: prompt,
      ts: Date.now(),
      mode,
      permission,
      modeLabel: mode
    });
    target.messages.push({
      role: 'assistant',
      content: result.text || '',
      ts: Date.now(),
      error: result.error || '',
      toolLog: result.toolLog,
      files: result.files,
      usage: result.usage || null
    });
    if (!target.title || target.title === 'New conversation') target.title = sessions.titleFrom(prompt);
    sessions.saveChat(target);
    return target;
  } catch (err) {
    if (process.env.DGXAY_DEBUG === '1') process.stderr.write(`[session] save failed: ${err.message}\n`);
    return null;
  }
}

module.exports = {
  name: 'run',
  aliases: [],
  summary: 'One-shot: send a prompt and print the reply',
  usage: 'dgxay run -p "prompt" [-C dir] [-m work] [--permission auto]',
  options,
  examples: [
    'dgxay run -p "explain the structure of this repo" -C .',
    'dgxay run -p "add install notes to the README" -m work -C ./project',
    'dgxay run -p "write a quicksort function" -o json'
  ],
  run
};
