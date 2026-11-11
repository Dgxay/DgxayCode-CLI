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
  { name: 'offline', type: 'boolean', desc: 'Skip network connectivity test' },
  { name: 'timeout', type: 'number', valueName: 'ms', desc: 'Connectivity test timeout, default 12000 ms' }
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
      messages: [{ role: 'user', content: 'Reply with just OK.' }],
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
  print.heading(`DgxayCode CLI self-check v${VERSION}`);
  print.write('');

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20 ? 'ok' : major >= 18 ? 'warn' : 'fail', `Node.js ${process.versions.node}`, major >= 18 ? '' : 'requires 18+');
  line('ok', `Platform ${process.platform} ${process.arch}`, `Home directory ${os.homedir()}`);
  if (typeof fetch !== 'function') line('fail', 'Global fetch unavailable', 'requires Node.js 18+');

  // 数据目录
  const dir = cfg.DCB_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
    line('ok', 'Data directory writable', settings.homeRelative(dir));
  } catch (err) {
    line('fail', 'Data directory not writable', `${dir} · ${err.message}`);
  }
  if (fs.existsSync(cfg.CONFIG_PATH)) line('ok', 'config.json present', settings.homeRelative(cfg.CONFIG_PATH));
  else line('warn', 'No config.json yet', 'run dgxay config init');

  const config = settings.readConfig();
  const mode = config.ui?.mode === 'work' ? 'work' : 'chat';
  const permission = settings.currentPermission(config);
  line('ok', `Mode / Permission`, `${mode === 'work' ? 'work mode' : 'chat mode'} · ${settings.PERMISSIONS[permission].label}`);
  if (config.ui?.permission === 'auto' && !settings.hasReviewModel(config)) {
    line('warn', 'Auto review fell back', 'the current/default provider has no valid review model');
  }

  const workspace = config.work?.workspace || '';
  if (workspace) {
    try {
      const isDir = fs.statSync(workspace).isDirectory();
      line(isDir ? 'ok' : 'fail', 'Workspace', workspace);
    } catch {
      line('warn', 'Workspace no longer exists', workspace);
    }
  } else {
    line('warn', 'No workspace selected', 'work mode cannot read or write files; set one with /cd or dgxay workspace set');
  }

  // 供应商
  print.write('');
  print.heading('Providers');
  const providers = config.providers || [];
  if (!providers.length) {
    line('fail', 'No providers', 'run dgxay config init');
  }
  for (const provider of providers) {
    const models = provider.models || [];
    const reviewOk = models.some((m) => m.id === provider.reviewModelId);
    line('ok', provider.name, `${provider.protocol || 'openai'} · ${provider.baseUrl} · ${models.length} models`);
    if (!reviewOk) line('warn', `  ${provider.name} invalid review model`, provider.reviewModelId || 'not configured');
    if (provider.authMode === 'oauth') {
      const account = oauth.listProviders().find((item) => item.id === provider.oauthProvider);
      if (account?.connection && !account.connection.expired) {
        line('ok', `  OAuth account`, `${provider.oauthProvider} · ${account.connection.account}`);
      } else {
        line('fail', `  OAuth account unavailable`, `dgxay oauth connect ${provider.oauthProvider || '<provider>'}`);
      }
    }
  }

  if (!opts.offline && providers.length) {
    print.write('');
    print.heading('Connectivity test');
    const active = settings.activeProvider(config);
    const model = settings.activeModel(config);
    if (!active || !model) {
      line('warn', 'Skipped: no current model');
    } else {
      process.stdout.write(`  ${COLORS.faint(`${SIGN.run} Requesting ${active.name} / ${model.id}…`)}`);
      const result = await checkConnectivity(active, model.id, timeout);
      process.stdout.write('\r\x1b[2K');
      if (result.ok) line('ok', `${active.name} / ${model.id}`, `${result.ms}ms${result.text ? ` · ${result.text}` : ''}`);
      else line('fail', `${active.name} / ${model.id}`, `${result.ms}ms · ${result.error}`);
    }
  }

  // OAuth / MCP / 技能
  print.write('');
  print.heading('Accounts and extensions');
  const accounts = oauth.listProviders();
  const connected = accounts.filter((item) => item.connection && !item.connection.expired);
  if (connected.length) {
    for (const account of connected) line('ok', `${account.name} account`, account.connection.account);
  } else {
    line('-', 'No connected OAuth accounts', 'optional: dgxay oauth connect openai');
  }
  const servers = mcp.listServers();
  if (servers.length) {
    for (const server of servers) {
      line('ok', `MCP ${server.name}`, `${server.command} ${(server.args || []).join(' ')}`.trim());
    }
    print.hint('  Note: this version only manages MCP processes; MCP tools are not yet exposed to the model');
  } else {
    line('-', 'No MCP servers');
  }
  const skillList = skills.listSkills();
  line(skillList.length ? 'ok' : '-', `Skills: ${skillList.length}`, settings.homeRelative(cfg.SKILLS_DIR));

  const chatsPath = path.join(dir, 'chats.json');
  if (fs.existsSync(chatsPath)) {
    try {
      const chats = JSON.parse(fs.readFileSync(chatsPath, 'utf8'));
      line('ok', 'Conversation history', `${Array.isArray(chats) ? chats.length : 0} entries`);
    } catch {
      line('warn', 'Conversation history could not be parsed', chatsPath);
    }
  }

  print.write('');
  return 0;
}

module.exports = {
  name: 'doctor',
  aliases: ['check'],
  summary: 'Self-check: environment, config, model connectivity',
  usage: 'dgxay doctor [--offline]',
  options,
  examples: ['dgxay doctor', 'dgxay doctor --offline'],
  run
};
