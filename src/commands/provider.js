'use strict';

/**
 * provider：供应商管理（对应桌面版「设置 → 供应商与模型」）。
 *
 *   dgxay provider list
 *   dgxay provider add --name DeepSeek --base-url https://api.deepseek.com/v1 --model deepseek-chat [--api-key sk-...]
 *   dgxay provider edit <名称> [--base-url ...] [--api-key ...] [--model ...]
 *   dgxay provider rm <名称>
 *   dgxay provider use <名称>          设为当前供应商
 *   dgxay provider mv <名称> up|down   调整顺序（第一个是默认供应商，也是审查模型回退来源）
 *   dgxay provider review <名称> [--model <id>]  设置自动审查模型；不带 --model 显示当前值
 */

const print = require('../cli/print');
const { parseArgs, actionFirst } = require('../cli/args');
const { COLORS } = require('../cli/ansi');
const settings = require('../services/settings');
const cfg = require('../services/config');
const oauth = require('../core/oauth');
const { ask, askSecret, confirm } = require('../services/input');

const options = [
  { name: 'name', type: 'string', valueName: 'text', desc: 'Provider name' },
  { name: 'protocol', type: 'string', valueName: 'p', desc: 'openai / anthropic / responses' },
  { name: 'base-url', type: 'string', valueName: 'url', desc: 'Base URL' },
  { name: 'api-key', type: 'string', valueName: 'key', desc: 'API Key' },
  { name: 'model', type: 'list', valueName: 'id', desc: 'Model ID (repeatable or comma-separated)' },
  { name: 'oauth-provider', type: 'string', valueName: 'id', desc: 'Use a connected OAuth account' },
  { name: 'review-model', type: 'string', valueName: 'id', desc: 'Auto review model ID' },
  { name: 'context-window', type: 'number', valueName: 'n', desc: 'Context window (optional)' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: 'Skip confirmation' }
];

function list() {
  const config = settings.readConfig();
  const providers = config.providers || [];
  print.blank();
  if (!providers.length) {
    print.hint('No providers yet. Run dgxay provider add or dgxay config init');
    print.blank();
    return 0;
  }
  print.heading(`Providers (${providers.length})`);
  const rows = providers.map((provider, index) => [
    String(index + 1),
    index === 0 ? COLORS.accent('default') : '',
    provider.id === config.activeProviderId ? COLORS.green('active') : '',
    provider.name,
    settings.PROTOCOL_META[provider.protocol || 'openai'].short,
    provider.baseUrl,
    (provider.models || []).map((m) => m.id || m.name).join(', '),
    provider.reviewModelId || '-',
    provider.authMode === 'oauth' ? `OAuth(${provider.oauthProvider || '?'})` : provider.apiKey ? cfg.maskKey(provider.apiKey) : '-'
  ]);
  print.table(
    [
      { title: '#', max: 3 },
      { title: '', max: 4 },
      { title: '', max: 4 },
      { title: 'Name', max: 16 },
      { title: 'Protocol', max: 16 },
      { title: 'Base URL', max: 40 },
      { title: 'Models', max: 30 },
      { title: 'Review model', max: 18 },
      { title: 'Auth', max: 16 }
    ],
    rows
  );
  print.blank();
  print.hint('Provider order matters: the first one is the default provider and the fallback source when no review model is configured');
  print.blank();
  return 0;
}

async function add(opts) {
  const interactive = process.stdin.isTTY && !opts.baseUrl;
  let protocol = opts.protocol || 'openai';
  let baseUrl = opts.baseUrl || '';
  let name = opts.name || '';
  let apiKey = opts.apiKey;
  let models = opts.model || [];
  let oauthProvider = opts.oauthProvider || '';

  if (interactive) {
    if (!opts.protocol) {
      const answer = await ask('Protocol [1] OpenAI ChatCompletions  [2] Anthropic Messages  [3] OpenAI Responses : ');
      const index = Number(String(answer || '').trim()) || 1;
      protocol = ['openai', 'anthropic', 'responses'][index - 1] || 'openai';
    }
    if (!baseUrl) {
      const answer = await ask(`Base URL [${settings.PROTOCOL_META[protocol].basePlaceholder}]: `);
      baseUrl = String(answer || '').trim() || settings.PROTOCOL_META[protocol].basePlaceholder;
    }
    if (!name) {
      const answer = await ask('Provider name: ');
      name = String(answer || '').trim();
    }
    if (!oauthProvider && apiKey === undefined) {
      const secret = await askSecret('API Key (may be empty for local models): ');
      apiKey = secret === null ? undefined : secret;
    }
    if (!models.length) {
      const answer = await ask('Model ID (separate multiple with commas): ');
      models = String(answer || '')
        .split(/[,，\s]+/)
        .filter(Boolean);
    }
  }

  const result = settings.upsertProvider({
    name: name || undefined,
    protocol,
    baseUrl,
    apiKey,
    models,
    authMode: oauthProvider ? 'oauth' : 'apiKey',
    oauthProvider,
    reviewModelId: opts.reviewModelId
  });
  print.ok(`Provider added: ${result.provider.name} (${result.provider.id})`);
  return 0;
}

function edit(ref, opts) {
  const provider = settings.findProvider(ref);
  if (!provider) {
    print.fail(`Provider not found: ${ref}`);
    return 1;
  }
  const result = settings.upsertProvider({
    ref: provider.id,
    name: opts.name,
    protocol: opts.protocol,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    models: opts.model?.length ? opts.model : undefined,
    authMode: opts.oauthProvider ? 'oauth' : provider.authMode,
    oauthProvider: opts.oauthProvider,
    reviewModelId: opts.reviewModelId
  });
  print.ok(`Provider updated: ${result.provider.name}`);
  return 0;
}

async function remove(ref, opts) {
  const provider = settings.findProvider(ref);
  if (!provider) {
    print.fail(`Provider not found: ${ref}`);
    return 1;
  }
  if (!opts.yes && process.stdin.isTTY) {
    const ok = await confirm(`Delete provider "${provider.name}" and its API key?`, false);
    if (!ok) {
      print.hint('Cancelled');
      return 1;
    }
  }
  const config = settings.removeProvider(provider.id);
  print.ok(`Deleted "${provider.name}"`);
  if (!config.providers?.length) print.hint('No providers left; run dgxay config init to reconfigure');
  else if (config.activeProviderId !== settings.readConfig().activeProviderId) {
    print.hint(`Active provider switched to "${(config.providers || []).find((p) => p.id === config.activeProviderId)?.name || 'unknown'}"`);
  }
  return 0;
}

function use(ref) {
  const provider = settings.findProvider(ref);
  if (!provider) {
    print.fail(`Provider not found: ${ref}`);
    return 1;
  }
  const model = provider.models?.[0];
  if (!model) {
    print.fail(`Provider ${provider.name} has no models`);
    return 1;
  }
  settings.saveConfig({ activeProviderId: provider.id, activeModelId: model.id });
  print.ok(`Active provider: ${provider.name} / ${model.name || model.id}`);
  return 0;
}

function review(ref, opts) {
  const provider = settings.findProvider(ref);
  if (!provider) {
    print.fail(`Provider not found: ${ref}`);
    return 1;
  }
  if (opts.reviewModel === undefined) {
    const model = (provider.models || []).find((m) => m.id === provider.reviewModelId);
    if (model) print.write(`Review model for ${provider.name}: ${model.name || model.id} (${model.id})`);
    else print.write(`${provider.name} has no review model configured; auto review falls back to the default provider`);
    return 0;
  }
  const models = provider.models || [];
  const target = models.find((m) => m.id === opts.reviewModel);
  if (opts.reviewModel && !target) {
    print.fail(`Provider ${provider.name} has no model ${opts.reviewModel}`);
    print.hint(`Available: ${models.map((m) => m.id).join(', ')}`);
    return 1;
  }
  const next = (settings.readConfig().providers || []).map((p) =>
    p.id === provider.id ? { ...p, reviewModelId: target ? target.id : '' } : p
  );
  settings.saveConfig({ providers: next });
  if (target) {
    print.ok(`Auto review model for ${provider.name}: ${target.name || target.id}`);
    print.hint('You can now select "Auto review" in /permission');
  } else {
    print.ok(`Cleared the review model for ${provider.name}`);
  }
  return 0;
}

function move(ref, direction) {
  const dir = direction === 'up' || direction === 'u' || direction === '-1' ? -1 : 1;
  settings.moveProvider(ref, dir);
  print.ok(`${dir < 0 ? 'Moved up' : 'Moved down'} "${settings.findProvider(ref)?.name || ref}"`);
  return list();
}

function oauthAccounts() {
  const list = oauth.listProviders();
  print.blank();
  print.heading('OAuth accounts');
  const rows = list.map((item) => [
    item.name,
    item.subtitle,
    item.connection && !item.connection.expired
      ? COLORS.green('connected')
      : item.connection?.expired
        ? COLORS.yellow('expired')
        : 'not connected',
    item.connection?.account || '',
    item.redirectMode === 'manual' ? 'manual auth code' : 'system browser'
  ]);
  print.table(
    [
      { title: 'Platform', max: 12 },
      { title: 'Account type', max: 24 },
      { title: 'Status', max: 8 },
      { title: 'Account', max: 30 },
      { title: 'Auth method', max: 12 }
    ],
    rows
  );
  print.blank();
  print.hint('dgxay oauth connect <platform> to connect an account; then use dgxay provider add --oauth-provider <platform>');
  print.blank();
  return 0;
}

async function run({ argv }) {
  const { action: rawAction, rest, options: opts } = actionFirst(argv, options);
  const action = rawAction || 'list';

  switch (action) {
    case 'list':
    case 'ls':
      return list();
    case 'add':
      return add(opts);
    case 'edit':
    case 'set': {
      if (!rest[0]) throw Object.assign(new Error('Usage: dgxay provider edit <name> [options]'), { userError: true });
      return edit(rest[0], opts);
    }
    case 'rm':
    case 'remove':
    case 'delete': {
      if (!rest[0]) throw Object.assign(new Error('Usage: dgxay provider rm <name>'), { userError: true });
      return remove(rest[0], opts);
    }
    case 'use': {
      if (!rest[0]) throw Object.assign(new Error('Usage: dgxay provider use <name>'), { userError: true });
      return use(rest[0]);
    }
    case 'mv':
    case 'move': {
      if (!rest[0]) throw Object.assign(new Error('Usage: dgxay provider mv <name> up|down'), { userError: true });
      return move(rest[0], rest[1] || 'down');
    }
    case 'review': {
      if (!rest[0]) {
        const config = settings.readConfig();
        const rows = (config.providers || []).map((p) => [p.name, p.reviewModelId || '(not configured)']);
        print.blank();
        print.table(
          [
            { title: 'Provider', max: 20 },
            { title: 'Review model', max: 30 }
          ],
          rows
        );
        print.blank();
        return 0;
      }
      return review(rest[0], opts);
    }
    case 'oauth':
      return oauthAccounts();
    default:
      print.fail(`Unknown subcommand: ${action}`);
      print.hint('Available: list / add / edit / rm / use / mv / review / oauth');
      return 1;
  }
}

module.exports = {
  name: 'provider',
  aliases: ['prov'],
  summary: 'Provider and review model management',
  usage: 'dgxay provider <list|add|edit|rm|use|mv|review>',
  options,
  subcommands: [
    ['list', 'List all providers'],
    ['add', 'Add a provider'],
    ['edit <name>', 'Edit a provider'],
    ['rm <name>', 'Delete a provider'],
    ['use <name>', 'Set as the active provider'],
    ['mv <name> up|down', 'Reorder providers'],
    ['review [name] [--model id]', 'View / set the auto review model']
  ],
  examples: [
    'dgxay provider list',
    'dgxay provider add --name DeepSeek --base-url https://api.deepseek.com/v1 --model deepseek-chat',
    'dgxay provider add --oauth-provider openai --base-url https://api.openai.com/v1 --model gpt-5',
    'dgxay provider review DeepSeek --model deepseek-chat'
  ],
  run
};
