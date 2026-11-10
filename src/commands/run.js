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
  { name: 'prompt', alias: 'p', type: 'string', valueName: 'text', desc: '提示词' },
  { name: 'mode', alias: 'm', type: 'string', valueName: 'mode', desc: 'chat / work（默认 chat）' },
  { name: 'permission', type: 'string', valueName: 'level', desc: 'none / normal / auto / full' },
  { name: 'workspace', alias: 'C', type: 'string', valueName: 'dir', desc: '工作空间目录' },
  { name: 'provider', type: 'string', valueName: 'name', desc: '供应商 id 或名称' },
  { name: 'model', type: 'string', valueName: 'id', desc: '模型 id' },
  { name: 'skill', type: 'string', valueName: 'name', desc: '启用的技能' },
  { name: 'resume', alias: 'r', type: 'string', valueName: 'id|index', desc: '在指定会话上继续' },
  { name: 'continue', alias: 'c', type: 'boolean', desc: '在最近的会话上继续' },
  { name: 'output', alias: 'o', type: 'string', valueName: 'text|json', desc: '输出格式，默认 text' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: '自动同意授权请求（危险）' },
  { name: 'quiet', alias: 'q', type: 'boolean', desc: '只输出回答正文' }
];

async function run({ argv, globalOptions, runtime }) {
  const { options: opts, positionals } = parseArgs(argv, options);
  const prompt = String(opts.prompt || positionals.join(' ') || runtime.prompt || '').trim();
  if (!prompt) {
    throw Object.assign(new Error('缺少提示词：请使用 -p "..." 或直接跟问题'), { userError: true });
  }

  const config = settings.readConfig();
  if (!config.providers?.length) {
    throw Object.assign(new Error('尚未配置供应商，请先运行 dgxay config init'), { userError: true });
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
    if (!target.title || target.title === '新对话') target.title = sessions.titleFrom(prompt);
    sessions.saveChat(target);
    return target;
  } catch (err) {
    if (process.env.DGXAY_DEBUG === '1') process.stderr.write(`[session] 保存失败：${err.message}\n`);
    return null;
  }
}

module.exports = {
  name: 'run',
  aliases: [],
  summary: '单次执行：把提示词发给模型并输出结果',
  usage: 'dgxay run -p "提示词" [-C 目录] [-m work] [--permission auto]',
  options,
  examples: [
    'dgxay run -p "解释这个仓库的目录结构" -C .',
    'dgxay run -p "给 README 补充安装说明" -m work -C ./project --permission normal',
    'dgxay run -p "写一个快排函数" -o json'
  ],
  run
};
