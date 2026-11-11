'use strict';

/**
 * 首次配置向导 / 配置查看。
 *
 *   dgxay config init                     交互式填写供应商、Base URL、API Key、模型
 *   dgxay config init --protocol openai --base-url ... --api-key ... --model gpt-4o
 *   dgxay config show                     查看当前配置（密钥打码）
 *   dgxay config get <a.b.c>             读取单项配置
 *   dgxay config set <a.b.c> <value>     写入单项配置
 *   dgxay config path                     显示数据目录与各文件的路径
 *   dgxay config reset                    重置配置（不删除 oauth.json / mcp.json / skills）
 */

const fs = require('fs');
const path = require('path');
const print = require('../cli/print');
const { parseArgs, actionFirst } = require('../cli/args');
const { COLORS, termWidth } = require('../cli/ansi');
const settings = require('../services/settings');
const cfg = require('../services/config');
const oauth = require('../core/oauth');
const { ask, askSecret, confirm } = require('../services/input');
const { VERSION } = require('../services/version');

const PRESETS = [
  { name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { name: 'OpenAI Responses', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
  { name: 'Qwen (DashScope)', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Moonshot', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: 'Ollama (local)', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' }
];

const options = [
  { name: 'protocol', type: 'string', valueName: 'p', desc: 'openai / anthropic / responses' },
  { name: 'name', type: 'string', valueName: 'text', desc: 'Provider name' },
  { name: 'base-url', type: 'string', valueName: 'url', desc: 'Base URL' },
  { name: 'api-key', type: 'string', valueName: 'key', desc: 'API Key (DGXAY_API_KEY env var also works)' },
  { name: 'model', type: 'list', valueName: 'id', desc: 'Model ID; repeatable or comma-separated' },
  { name: 'oauth-provider', type: 'string', valueName: 'id', desc: 'Use a connected OAuth account instead: openai/anthropic/xai/google' },
  { name: 'force', alias: 'f', type: 'boolean', desc: 'Overwrite even when config already exists' }
];

/* ------------------------------ init ------------------------------ */

async function promptProtocol(config) {
  const interactive = process.stdin.isTTY;
  if (!interactive) return 'openai';
  print.blank();
  print.heading('API protocol');
  const list = ['openai', 'anthropic', 'responses'];
  list.forEach((key, index) => {
    const meta = settings.PROTOCOL_META[key];
    print.write(`  ${COLORS.accent(String(index + 1))}. ${meta.full} ${COLORS.faint(meta.path)}`);
  });
  const answer = await ask(`Choose [1-3, default 1]: `);
  const index = Number(String(answer || '').trim());
  if (Number.isInteger(index) && index >= 1 && index <= 3) return list[index - 1];
  return 'openai';
}

async function promptPreset(protocol) {
  const interactive = process.stdin.isTTY;
  if (!interactive) return null;
  print.blank();
  print.heading('Quick presets');
  const matches = PRESETS.filter((preset) => preset.protocol === protocol);
  matches.forEach((preset, index) => {
    print.write(`  ${COLORS.accent(String(index + 1))}. ${preset.name} ${COLORS.faint(preset.baseUrl)}`);
  });
  print.write(`  ${COLORS.faint('Press Enter to skip and fill in manually')}`);
  const answer = await ask('Choose a preset: ');
  const index = Number(String(answer || '').trim());
  if (Number.isInteger(index) && index >= 1 && index <= matches.length) return matches[index - 1];
  return null;
}

async function runInit(opts, runtime) {
  const config = settings.readConfig();
  if (config.providers?.length && !opts.force) {
    print.warn(`${config.providers.length} provider(s) already configured. Use dgxay provider add to append a new provider`);
    print.hint('To re-initialize the first provider, add --force');
    return 1;
  }

  const interactive = Boolean(process.stdin.isTTY) && !opts.protocol && !opts.baseUrl;
  let protocol = String(opts.protocol || '').trim();
  let name = String(opts.name || '').trim();
  let baseUrl = String(opts.baseUrl || '').trim();
  let apiKey = opts.apiKey !== undefined ? String(opts.apiKey) : process.env.DGXAY_API_KEY || '';
  let models = (opts.model || []).flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean);
  let oauthProvider = String(opts.oauthProvider || '').trim();

  if (interactive) {
    print.write('');
    print.write(`${COLORS.bold('DgxayCode first-time setup')} ${COLORS.faint(`v${VERSION}`)}`);
    print.write(COLORS.faint('Config is written to the local data directory; the API key stays on this machine and is never uploaded.'));
    print.write(COLORS.faint(`Data directory: ${cfg.DCB_DIR}`));

    protocol = protocol || (await promptProtocol(config));
    const preset = await promptPreset(protocol);
    if (preset) {
      name = name || preset.name;
      baseUrl = baseUrl || preset.baseUrl;
      models = models.length ? models : [preset.model];
      print.write(COLORS.faint(`Selected ${preset.name}, Base URL pre-filled with ${preset.baseUrl}`));
    }

    if (!name) {
      const answer = await ask(`Provider name [${preset?.name || 'My provider'}]: `);
      name = String(answer || '').trim() || preset?.name || 'My provider';
    }
    if (!baseUrl) {
      const answer = await ask(`Base URL [${settings.PROTOCOL_META[protocol].basePlaceholder}]: `);
      baseUrl = String(answer || '').trim() || settings.PROTOCOL_META[protocol].basePlaceholder;
    }

    const useOauth = await confirm('Use a connected OAuth account (instead of an API Key)?', false);
    if (useOauth) {
      const connected = oauth.listProviders().filter((item) => item.connection && !item.connection.expired);
      if (!connected.length) {
        print.warn('No accounts available yet; continue with an API Key. You can run dgxay oauth connect <platform> later');
      } else {
        connected.forEach((item, index) =>
          print.write(`  ${COLORS.accent(String(index + 1))}. ${item.name} ${COLORS.faint(item.connection.account)}`)
        );
        const answer = await ask('Choose an account [1]: ');
        const index = Number(String(answer || '').trim()) || 1;
        oauthProvider = connected[index - 1]?.id || '';
      }
    }

    if (!oauthProvider && !apiKey) {
      const secret = await askSecret('API Key (may be empty for local models): ');
      apiKey = secret !== null ? secret : '';
    }
    if (!models.length) {
      const answer = await ask(`Model ID [${settings.PROTOCOL_META[protocol].modelPlaceholder}]: `);
      models = String(answer || '')
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (!models.length) {
      print.fail('Model ID cannot be empty');
      return 1;
    }
  }

  if (!protocol) protocol = 'openai';
  if (!baseUrl) baseUrl = settings.PROTOCOL_META[protocol].basePlaceholder;
  if (!models.length) {
    throw Object.assign(new Error('Missing --model, e.g. --model deepseek-chat'), { userError: true });
  }
  if (!apiKey && !oauthProvider) {
    print.warn('No API Key provided: local models (Ollama, etc.) work without one, cloud endpoints return 401');
  }

  const result = settings.upsertProvider({
    protocol,
    name,
    baseUrl,
    apiKey,
    models,
    authMode: oauthProvider ? 'oauth' : 'apiKey',
    oauthProvider
  });
  settings.saveConfig({ onboarded: true });

  print.blank();
  print.ok(`Provider saved: '${result.provider.name}'（${settings.PROTOCOL_META[result.provider.protocol].full}）`);
  print.keyValue([
    { label: 'Base URL', value: result.provider.baseUrl },
    { label: 'Models', value: result.provider.models.map((m) => m.id).join(', ') },
    { label: 'Review model', value: result.provider.reviewModelId || 'not configured' },
    { label: 'Auth', value: oauthProvider ? `OAuth · ${oauthProvider}` : apiKey ? 'API Key' : 'none (local model)' },
    { label: 'Config file', value: settings.homeRelative(cfg.CONFIG_PATH) }
  ]);
  print.blank();
  print.hint('Next: run dgxay doctor to check connectivity, then run dgxay to start chatting');
  void interactive;
  void runtime;
  return 0;
}

/* ------------------------------ show / get / set / path / reset ------------------------------ */

function runShow() {
  const config = settings.readConfig();
  const provider = settings.activeProvider(config);
  const model = settings.activeModel(config);
  print.heading('Current config');
  print.keyValue(
    [
      { label: 'Data directory', value: settings.homeRelative(cfg.DCB_DIR) },
      { label: 'Config file', value: settings.homeRelative(cfg.CONFIG_PATH) },
      { label: 'Mode', value: config.ui?.mode === 'work' ? 'work mode' : 'chat mode' },
      {
        label: 'Permission',
        value: `${settings.PERMISSIONS[settings.currentPermission(config)].label}${
          config.ui?.permission === 'auto' && !settings.hasReviewModel(config) ? ' (review model missing, fell back to normal permission)' : ''
        }`
      },
      { label: 'Workspace', value: config.work?.workspace || '(not selected)' },
      { label: 'Active provider', value: provider ? `${provider.name} (${provider.id})` : 'not configured' },
      { label: 'Active model', value: model ? `${model.name}${model.id !== model.name ? ` (${model.id})` : ''}` : 'not configured' },
      { label: 'Streaming', value: config.chat?.stream === false ? 'off' : 'on' },
      { label: 'Temperature', value: String(config.chat?.temperature ?? 0.7) },
      { label: 'Max output', value: String(config.chat?.maxTokens ?? 4096) },
      { label: 'Custom instructions', value: config.chat?.systemPrompt ? 'set' : 'not set' }
    ],
    {}
  );
  print.blank();
  print.heading('Providers');
  if (!config.providers?.length) {
    print.hint('  No providers yet, run dgxay config init');
    return 0;
  }
  const rows = config.providers.map((item, index) => [
    String(index + 1),
    item.name,
    settings.PROTOCOL_META[item.protocol || 'openai'].short,
    item.baseUrl,
    item.authMode === 'oauth' ? `OAuth(${item.oauthProvider || '?'})` : item.apiKey ? cfg.maskKey(item.apiKey) : 'none',
    (item.models || []).length,
    item.reviewModelId || '-'
  ]);
  print.table(
    [
      { title: '#', max: 3 },
      { title: 'Name', max: 18 },
      { title: 'Protocol', max: 16 },
      { title: 'Base URL', max: 40 },
      { title: 'Auth', max: 16 },
      { title: 'Models', max: 5 },
      { title: 'Review model', max: 20 }
    ],
    rows
  );
  print.blank();
  print.hint('Add/modify providers: dgxay provider --help');
  return 0;
}

function getPath(object, keyPath) {
  return String(keyPath)
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
}

function runCmd(argv) {
  const { positionals } = parseArgs(argv, []);
  const action = positionals[0] || 'show';
  return { action, rest: positionals.slice(1) };
}

async function run({ argv, runtime }) {
  const { action, rest, options: opts } = actionFirst(argv, options);

  if (action === 'init') return runInit(opts, runtime);
  if (action === 'show' || action === 'list' || !action) return runShow();

  if (action === 'get') {
    if (!rest[0]) throw Object.assign(new Error('Specify a config key, e.g. dgxay config get ui.permission'), { userError: true });
    const value = getPath(settings.readConfig(), rest[0]);
    if (value === undefined) {
      print.fail(`No such config key: ${rest[0]}`);
      return 1;
    }
    process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    return 0;
  }

  if (action === 'set') {
    const key = rest[0];
    const raw = rest.slice(1).join(' ');
    if (!key || !raw) {
      throw Object.assign(new Error('Usage: dgxay config set <key> <value>, e.g. dgxay config set chat.temperature 0.3'), {
        userError: true
      });
    }
    const allowed = ['ui.permission', 'ui.mode', 'chat.temperature', 'chat.maxTokens', 'chat.stream', 'chat.systemPrompt'];
    if (!allowed.includes(key)) {
      throw Object.assign(new Error(`Cannot modify ${key}. Editable keys: ${allowed.join(', ')}`), { userError: true });
    }
    let value = raw;
    if (key === 'chat.temperature' || key === 'chat.maxTokens') value = Number(raw);
    if (!Number.isFinite(value) && typeof value === 'number') {
      throw Object.assign(new Error('A number is required'), { userError: true });
    }
    if (key === 'chat.stream') value = !/^(false|0|no|off)$/i.test(raw);
    if (key === 'ui.permission' && !settings.PERMISSIONS[raw]) {
      throw Object.assign(new Error('Permission must be one of none / normal / auto / full'), { userError: true });
    }
    const [section, name] = key.split('.');
    settings.saveConfig({ [section]: { [name]: value } });
    print.ok(`${key} = ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    return 0;
  }

  if (action === 'path') {
    const paths = settings.paths();
    print.keyValue([
      { label: 'Data directory', value: paths.dataDir },
      { label: 'Config file', value: paths.config },
      { label: 'Conversations', value: paths.chats },
      { label: 'OAuth', value: paths.oauth },
      { label: 'MCP', value: paths.mcp },
      { label: 'Skills directory', value: paths.skills }
    ]);
    return 0;
  }

  if (action === 'reset') {
    const yes =
      argv.includes('--yes') ||
      (await confirm('This resets all config (providers, keys, preferences) and clears conversation history. Continue?', false));
    if (!yes) {
      print.hint('Cancelled');
      return 1;
    }
    const backup = `${cfg.CONFIG_PATH}.bak-${Date.now()}`;
    try {
      if (fs.existsSync(cfg.CONFIG_PATH)) fs.copyFileSync(cfg.CONFIG_PATH, backup);
    } catch {
      /* ignore */
    }
    cfg.resetConfig();
    cfg.saveChats([]);
    print.ok('Config reset');
    print.hint('oauth.json, mcp.json and skills/ are not deleted; remove the data directory manually for a full clean-up');
    if (fs.existsSync(backup)) print.hint(`Previous config backed up to ${path.basename(backup)}`);
    return 0;
  }

  print.fail(`Unknown config subcommand: ${action}`);
  print.hint('Available: init / show / get / set / path / reset');
  return 1;
}

module.exports = {
  name: 'config',
  aliases: ['cfg'],
  summary: 'Config: initialize, view, modify data directory',
  usage: 'dgxay config <init|show|get|set|path|reset>',
  options,
  subcommands: [
    ['init', 'Initial config of provider and model'],
    ['show', 'View current config (keys masked)'],
    ['get <key>', 'Read a single config key'],
    ['set <key> <value>', 'Set a single config key'],
    ['path', 'Show data directory and file paths'],
    ['reset', 'Reset config (keeps OAuth / MCP / skills)']
  ],
  examples: ['dgxay config init', 'dgxay config show', 'dgxay config set chat.temperature 0.3', 'dgxay config path'],
  run,
  runCmd,
  getPath
};
