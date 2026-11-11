'use strict';

/**
 * model：模型管理。
 *
 *   dgxay model list                 列出当前供应商的模型与上下文窗口
 *   dgxay model use <id|序号>         设为当前模型
 *   dgxay model add <id> [--name X] [--context-window N] [--provider P]
 *   dgxay model rm <id> [--provider P]
 *   dgxay model fetch [--provider P] [--base-url ...] [--api-key ...]
 */

const print = require('../cli/print');
const { parseArgs, actionFirst } = require('../cli/args');
const { COLORS } = require('../cli/ansi');
const settings = require('../services/settings');
const sessions = require('../core/sessions');
const { askSecret } = require('../services/input');

const options = [
  { name: 'provider', alias: 'p', type: 'string', valueName: 'name', desc: 'Target provider (default: active provider)' },
  { name: 'name', type: 'string', valueName: 'text', desc: 'Display name' },
  { name: 'context-window', type: 'number', valueName: 'n', desc: 'Context window' },
  { name: 'base-url', type: 'string', valueName: 'url', desc: 'Use this base URL when fetching the list' },
  { name: 'api-key', type: 'string', valueName: 'key', desc: 'Use this key when fetching the list' },
  { name: 'add', type: 'list', valueName: 'id', desc: 'Add the given models to the provider after fetching' }
];

function list(providerRef) {
  const config = settings.readConfig();
  const provider = providerRef ? settings.findProvider(providerRef) : settings.activeProvider(config);
  if (!provider) {
    print.warn('No providers yet, run dgxay config init');
    return 1;
  }
  const models = provider.models || [];
  print.blank();
  print.heading(`Models for ${provider.name} (${models.length})`);
  if (!models.length) {
    print.hint('  No models yet, run dgxay model add <id>');
    print.blank();
    return 0;
  }
  const active = provider.id === config.activeProviderId ? config.activeModelId : '';
  const rows = models.map((model, index) => [
    String(index + 1),
    model.id === active ? COLORS.accent('❯') : ' ',
    model.name || model.id,
    model.id,
    model.contextWindow ? sessions.formatTokens(model.contextWindow) : COLORS.faint('protocol default'),
    provider.reviewModelId === model.id ? 'review' : ''
  ]);
  print.table(
    [
      { title: '#', max: 3 },
      { title: '', max: 1 },
      { title: 'Name', max: 26 },
      { title: 'ID', max: 32 },
      { title: 'Context', max: 10 },
      { title: '', max: 4 }
    ],
    rows
  );
  print.blank();
  return 0;
}

async function fetchList(opts) {
  const config = settings.readConfig();
  const provider = opts.provider ? settings.findProvider(opts.provider) : settings.activeProvider(config);
  let apiKey = opts.apiKey;
  if (apiKey === undefined && provider && !(provider.authMode === 'oauth') && !provider.apiKey) {
    const secret = await askSecret('API Key: ');
    apiKey = secret || '';
  }
  process.stdout.write(`${COLORS.faint('Fetching model list...')}`);
  try {
    let models;
    if (opts.baseUrl) {
      models = await settings.fetchModels({
        baseUrl: opts.baseUrl,
        apiKey: apiKey ?? '',
        protocol: opts.protocol || provider?.protocol || 'openai'
      });
    } else {
      if (!provider) throw new Error('No provider available');
      models = await settings.fetchModels({ providerRef: provider.id, apiKey });
    }
    process.stdout.write('\r\x1b[2K');
    print.ok(`Fetched ${models.length} model(s)`);
    const existing = new Set((provider?.models || []).map((m) => m.id));
    for (const id of models) {
      print.write(`  ${existing.has(id) ? COLORS.green('✓') : ' '} ${id}`);
    }
    print.blank();
    print.hint('Use dgxay model add <id> to add to the provider; if fetching fails you can type the model ID manually');
    return 0;
  } catch (err) {
    process.stdout.write('\r\x1b[2K');
    print.fail(`Fetch failed: ${err.message}`);
    print.hint('Some gateways do not support the /models endpoint; add models manually with dgxay model add <id>');
    return 1;
  }
}

function addModel(id, opts) {
  const config = settings.readConfig();
  const provider = opts.provider ? settings.findProvider(opts.provider) : settings.activeProvider(config);
  if (!provider) {
    print.warn('No providers yet, run dgxay config init');
    return 1;
  }
  const models = (provider.models || []).slice();
  if (models.some((m) => m.id === id)) {
    print.warn(`Model ${id} already exists`);
    return 1;
  }
  models.push({
    id,
    name: opts.name || id,
    contextWindow: Number(opts.contextWindow) || 0
  });
  const next = (config.providers || []).map((p) => (p.id === provider.id ? { ...p, models } : p));
  const patch = { providers: next };
  if (provider.id === config.activeProviderId && !config.activeModelId) patch.activeModelId = id;
  settings.saveConfig(patch);
  print.ok(`Model added: ${id}`);
  return 0;
}

function removeModel(id, opts) {
  const config = settings.readConfig();
  const provider = opts.provider ? settings.findProvider(opts.provider) : settings.activeProvider(config);
  if (!provider) {
    print.warn('No providers yet');
    return 1;
  }
  const models = (provider.models || []).filter((m) => m.id !== id);
  if (models.length === (provider.models || []).length) {
    print.fail(`Provider ${provider.name} has no model ${id}`);
    return 1;
  }
  if (!models.length) {
    print.fail('Cannot delete the last model; add another model first');
    return 1;
  }
  const reviewModelId = models.some((m) => m.id === provider.reviewModelId)
    ? provider.reviewModelId
    : models[0].id;
  const next = (config.providers || []).map((p) =>
    p.id === provider.id ? { ...p, models, reviewModelId } : p
  );
  const patch = { providers: next };
  if (config.activeModelId === id) patch.activeModelId = models[0].id;
  settings.saveConfig(patch);
  print.ok(`Model deleted: ${id}`);
  return 0;
}

function useModel(ref, opts) {
  const config = settings.readConfig();
  const provider = opts.provider ? settings.findProvider(opts.provider) : settings.activeProvider(config);
  if (!provider) {
    print.warn('No providers yet');
    return 1;
  }
  const models = provider.models || [];
  const index = Number(ref);
  const target =
    (Number.isInteger(index) && index >= 1 && index <= models.length ? models[index - 1] : null) ||
    models.find((m) => m.id === ref) ||
    models.find((m) => m.id.includes(ref));
  if (!target) {
    print.fail(`Model not found: ${ref}`);
    return 1;
  }
  settings.setActiveModel(provider.id, target.id);
  print.ok(`Active model: ${target.name || target.id} (${provider.name})`);
  return 0;
}

async function run({ argv }) {
  const { action: rawAction, rest, options: opts } = actionFirst(argv, options);
  const action = rawAction || 'list';

  // model add deepseek-chat gpt-4o 支持多个
  if (action === 'add') {
    if (!rest.length) throw Object.assign(new Error('Usage: dgxay model add <id> [<id>...]'), { userError: true });
    let code = 0;
    for (const id of rest) code = Math.max(code, addModel(id, opts));
    return code;
  }
  if (action === 'rm' || action === 'remove' || action === 'delete') {
    if (!rest[0]) throw Object.assign(new Error('Usage: dgxay model rm <id>'), { userError: true });
    return removeModel(rest[0], opts);
  }
  if (action === 'use' || action === 'set') {
    if (!rest[0]) throw Object.assign(new Error('Usage: dgxay model use <id|index>'), { userError: true });
    return useModel(rest[0], opts);
  }
  if (action === 'fetch' || action === 'ls-remote') return fetchList(opts);
  if (action === 'list' || action === 'ls') return list(opts.provider);

  // 不是已知子命令：当作模型 ID 使用
  return useModel(action, opts);
}

module.exports = {
  name: 'model',
  aliases: ['models'],
  summary: 'Model management: list, switch, add/remove, fetch',
  usage: 'dgxay model <list|use|add|rm|fetch>',
  options,
  subcommands: [
    ['list', 'List models'],
    ['use <id|index>', 'Switch the active model'],
    ['add <id>', 'Add a model'],
    ['rm <id>', 'Delete a model'],
    ['fetch', 'Fetch the model list from the provider API']
  ],
  examples: ['dgxay model list', 'dgxay model use 2', 'dgxay model add gpt-4o --name GPT-4o', 'dgxay model fetch'],
  run
};
