'use strict';

/**
 * doctor：环境自检。检查 Node 版本、数据目录、权限、供应商、模型连通性、OAuth、MCP、技能。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const print = require('../cli/print');
const { COLORS, SIGN } = require('../cli/ansi');
const settings = require('../services/settings');
const cfg = require('../services/config');
const mcp = require('../core/mcp');
const skills = require('../services/skills');
const oauth = require('../core/oauth');
const { streamChat } = require('../core/llm');
const { resolveProviderAuth } = require('../core/prompt');
const { VERSION } = require('../services/version');

const options = [
  { name: 'offline', type: 'boolean', desc: '跳过网络连通性测试' },
  { name: 'timeout', type: 'number', valueName: 'ms', desc: '连通性测试超时，默认 12000 毫秒' }
];

function line(status, label, detail = '') {
  const symbol =
    status === 'ok'
      ? COLORS.green(SIGN.ok)
      : status === 'warn'
        ? COLORS.yellow('!')
        : status === 'fail'
          ? COLORS.red(SIGN.fail)
          : COLORS.faint('-');
  process.stdout.write(`  ${symbol} ${label}${detail ? COLORS.faint(`  ${detail}`) : ''}\n`);
}

async function checkConnectivity(provider, modelId, timeout) {
  const auth = await resolveProviderAuth(provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = Date.now();
  try {
    const result = await streamChat({
      protocol: provider.protocol || 'openai',
      baseUrl: provider.baseUrl,
      apiKey: auth.apiKey,
      authType: auth.authType,
      model: modelId,
      messages: [{ role: 'user', content: '回复 OK 两个字母即可。' }],
      stream: false,
      temperature: 0,
      maxTokens: 16,
      signal: controller.signal
    });
    return { ok: true, ms: Date.now() - started, text: String(result.content || '').trim().slice(0, 60) };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function run({ argv }) {
  const { parseArgs } = require('../cli/args');
  const { options: opts } = parseArgs(argv, options);
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 12000;

  print.write('');
  print.heading(`DgxayCode CLI 自检 v${VERSION}`);
  print.write('');

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20 ? 'ok' : major >= 18 ? 'warn' : 'fail', `Node.js ${process.versions.node}`, major >= 18 ? '' : '需要 18+');
  line('ok', `平台 ${process.platform} ${process.arch}`, `主目录 ${os.homedir()}`);
  if (typeof fetch !== 'function') line('fail', '全局 fetch 不可用', '需要 Node.js 18+');

  // 数据目录
  const dir = cfg.DCB_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
    line('ok', '数据目录可写', settings.homeRelative(dir));
  } catch (err) {
    line('fail', '数据目录不可写', `${dir} · ${err.message}`);
  }
  if (fs.existsSync(cfg.CONFIG_PATH)) line('ok', '存在 config.json', settings.homeRelative(cfg.CONFIG_PATH));
  else line('warn', '尚无 config.json', '运行 dgxay config init');

  const config = settings.readConfig();
  const mode = config.ui?.mode === 'work' ? 'work' : 'chat';
  const permission = settings.currentPermission(config);
  line('ok', `模式 / 权限`, `${mode === 'work' ? '工作模式' : '对话模式'} · ${settings.PERMISSIONS[permission].label}`);
  if (config.ui?.permission === 'auto' && !settings.hasReviewModel(config)) {
    line('warn', '自动审查已回退', '当前/默认供应商没有有效的审查模型');
  }

  const workspace = config.work?.workspace || '';
  if (workspace) {
    try {
      const isDir = fs.statSync(workspace).isDirectory();
      line(isDir ? 'ok' : 'fail', '工作空间', workspace);
    } catch {
      line('warn', '工作空间已不存在', workspace);
    }
  } else {
    line('warn', '未选择工作空间', '工作模式下无法读写文件，用 /cd 或 dgxay workspace set 设置');
  }

  // 供应商
  print.write('');
  print.heading('供应商');
  const providers = config.providers || [];
  if (!providers.length) {
    line('fail', '没有供应商', '运行 dgxay config init');
  }
  for (const provider of providers) {
    const models = provider.models || [];
    const reviewOk = models.some((m) => m.id === provider.reviewModelId);
    line('ok', provider.name, `${provider.protocol || 'openai'} · ${provider.baseUrl} · ${models.length} 个模型`);
    if (!reviewOk) line('warn', `  ${provider.name} 审查模型无效`, provider.reviewModelId || '未配置');
    if (provider.authMode === 'oauth') {
      const account = oauth.listProviders().find((item) => item.id === provider.oauthProvider);
      if (account?.connection && !account.connection.expired) {
        line('ok', `  OAuth 账户`, `${provider.oauthProvider} · ${account.connection.account}`);
      } else {
        line('fail', `  OAuth 账户不可用`, `dgxay oauth connect ${provider.oauthProvider || '<平台>'}`);
      }
    }
  }

  if (!opts.offline && providers.length) {
    print.write('');
    print.heading('连通性测试');
    const active = settings.activeProvider(config);
    const model = settings.activeModel(config);
    if (!active || !model) {
      line('warn', '跳过：没有当前模型');
    } else {
      process.stdout.write(`  ${COLORS.faint(`${SIGN.run} 正在请求 ${active.name} / ${model.id}…`)}`);
      const result = await checkConnectivity(active, model.id, timeout);
      process.stdout.write('\r\x1b[2K');
      if (result.ok) line('ok', `${active.name} / ${model.id}`, `${result.ms}ms${result.text ? ` · ${result.text}` : ''}`);
      else line('fail', `${active.name} / ${model.id}`, `${result.ms}ms · ${result.error}`);
    }
  }

  // OAuth / MCP / 技能
  print.write('');
  print.heading('账户与扩展');
  const accounts = oauth.listProviders();
  const connected = accounts.filter((item) => item.connection && !item.connection.expired);
  if (connected.length) {
    for (const account of connected) line('ok', `${account.name} 账户`, account.connection.account);
  } else {
    line('-', '没有连接的 OAuth 账户', '可选：dgxay oauth connect openai');
  }
  const servers = mcp.listServers();
  if (servers.length) {
    for (const server of servers) {
      line('ok', `MCP ${server.name}`, `${server.command} ${(server.args || []).join(' ')}`.trim());
    }
    print.hint('  提示：当前版本只管理 MCP 进程，尚未把 MCP 工具暴露给模型');
  } else {
    line('-', '没有 MCP server');
  }
  const skillList = skills.listSkills();
  line(skillList.length ? 'ok' : '-', `技能 ${skillList.length} 个`, settings.homeRelative(cfg.SKILLS_DIR));

  const chatsPath = path.join(dir, 'chats.json');
  if (fs.existsSync(chatsPath)) {
    try {
      const chats = JSON.parse(fs.readFileSync(chatsPath, 'utf8'));
      line('ok', '对话记录', `${Array.isArray(chats) ? chats.length : 0} 段`);
    } catch {
      line('warn', '对话记录无法解析', chatsPath);
    }
  }

  print.write('');
  return 0;
}

module.exports = {
  name: 'doctor',
  aliases: ['check'],
  summary: '自检：环境、配置、模型连通性',
  usage: 'dgxay doctor [--offline]',
  options,
  examples: ['dgxay doctor', 'dgxay doctor --offline'],
  run
};
