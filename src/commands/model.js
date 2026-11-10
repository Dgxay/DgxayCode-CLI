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
  { name: 'provider', alias: 'p', type: 'string', valueName: 'name', desc: '指定供应商（默认当前供应商）' },
  { name: 'name', type: 'string', valueName: 'text', desc: '显示名称' },
  { name: 'context-window', type: 'number', valueName: 'n', desc: '上下文窗口' },
  { name: 'base-url', type: 'string', valueName: 'url', desc: '拉取列表时使用该地址' },
  { name: 'api-key', type: 'string', valueName: 'key', desc: '拉取列表时使用该密钥' },
  { name: 'add', type: 'list', valueName: 'id', desc: '拉取后把指定模型加入供应商' }
];

function list(providerRef) {
  const config = settings.readConfig();
  const provider = providerRef ? settings.findProvider(providerRef) : settings.activeProvider(config);
  if (!provider) {
    print.warn('还没有供应商，运行 dgxay config init');
    return 1;
  }
  const models = provider.models || [];
  print.blank();
  print.heading(`${provider.name} 的模型（${models.length}）`);
  if (!models.length) {
    print.hint('  还没有模型，运行 dgxay model add <id>');
    print.blank();
    return 0;
  }
  const active = provider.id === config.activeProviderId ? config.activeModelId : '';
  const rows = models.map((model, index) => [
    String(index + 1),
    model.id === active ? COLORS.accent('❯') : ' ',
    model.name || model.id,
    model.id,
    model.contextWindow ? sessions.formatTokens(model.contextWindow) : COLORS.faint('按协议默认'),
    provider.reviewModelId === model.id ? '审查' : ''
  ]);
  print.table(
    [
      { title: '#', max: 3 },
      { title: '', max: 1 },
      { title: '名称', max: 26 },
      { title: 'ID', max: 32 },
      { title: '上下文', max: 10 },
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
  process.stdout.write(`${COLORS.faint('正在拉取模型列表…')}`);
  try {
    let models;
    if (opts.baseUrl) {
      models = await settings.fetchModels({
        baseUrl: opts.baseUrl,
        apiKey: apiKey ?? '',
        protocol: opts.protocol || provider?.protocol || 'openai'
      });
    } else {
      if (!provider) throw new Error('没有可用的供应商');
      models = await settings.fetchModels({ providerRef: provider.id, apiKey });
    }
    process.stdout.write('\r\x1b[2K');
    print.ok(`拉到 ${models.length} 个模型`);
    const existing = new Set((provider?.models || []).map((m) => m.id));
    for (const id of models) {
      print.write(`  ${existing.has(id) ? COLORS.green('✓') : ' '} ${id}`);
    }
    print.blank();
    print.hint('用 dgxay model add <id> 加入供应商；拉取失败时也可以直接手动填写模型 ID');
    return 0;
  } catch (err) {
    process.stdout.write('\r\x1b[2K');
    print.fail(`拉取失败：${err.message}`);
    print.hint('部分网关不支持 /models 接口，可以直接用 dgxay model add <id> 手动添加');
    return 1;
  }
}

function addModel(id, opts) {
  const config = settings.readConfig();
  const provider = opts.provider ? settings.findProvider(opts.provider) : settings.activeProvider(config);
  if (!provider) {
    print.warn('还没有供应商，运行 dgxay config init');
    return 1;
  }
  const models = (provider.models || []).slice();
  if (models.some((m) => m.id === id)) {
    print.warn(`模型 ${id} 已存在`);
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
  print.ok(`已添加模型 ${id}`);
  return 0;
}

function removeModel(id, opts) {
  const config = settings.readConfig();
  const provider = opts.provider ? settings.findProvider(opts.provider) : settings.activeProvider(config);
  if (!provider) {
    print.warn('还没有供应商');
    return 1;
  }
  const models = (provider.models || []).filter((m) => m.id !== id);
  if (models.length === (provider.models || []).length) {
    print.fail(`供应商 ${provider.name} 下没有模型 ${id}`);
    return 1;
  }
  if (!models.length) {
    print.fail('不能删除最后一个模型，请先添加其他模型');
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
  print.ok(`已删除模型 ${id}`);
  return 0;
}

function useModel(ref, opts) {
  const config = settings.readConfig();
  const provider = opts.provider ? settings.findProvider(opts.provider) : settings.activeProvider(config);
  if (!provider) {
    print.warn('还没有供应商');
    return 1;
  }
  const models = provider.models || [];
  const index = Number(ref);
  const target =
    (Number.isInteger(index) && index >= 1 && index <= models.length ? models[index - 1] : null) ||
    models.find((m) => m.id === ref) ||
    models.find((m) => m.id.includes(ref));
  if (!target) {
    print.fail(`找不到模型：${ref}`);
    return 1;
  }
  settings.setActiveModel(provider.id, target.id);
  print.ok(`当前模型：${target.name || target.id}（${provider.name}）`);
  return 0;
}

async function run({ argv }) {
  const { action: rawAction, rest, options: opts } = actionFirst(argv, options);
  const action = rawAction || 'list';

  // model add deepseek-chat gpt-4o 支持多个
  if (action === 'add') {
    if (!rest.length) throw Object.assign(new Error('用法：dgxay model add <id> [<id>…]'), { userError: true });
    let code = 0;
    for (const id of rest) code = Math.max(code, addModel(id, opts));
    return code;
  }
  if (action === 'rm' || action === 'remove' || action === 'delete') {
    if (!rest[0]) throw Object.assign(new Error('用法：dgxay model rm <id>'), { userError: true });
    return removeModel(rest[0], opts);
  }
  if (action === 'use' || action === 'set') {
    if (!rest[0]) throw Object.assign(new Error('用法：dgxay model use <id|序号>'), { userError: true });
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
  summary: '模型管理：列表、切换、增删、拉取',
  usage: 'dgxay model <list|use|add|rm|fetch>',
  options,
  subcommands: [
    ['list', '列出模型'],
    ['use <id|序号>', '切换当前模型'],
    ['add <id>', '添加模型'],
    ['rm <id>', '删除模型'],
    ['fetch', '从供应商接口拉取模型列表']
  ],
  examples: ['dgxay model list', 'dgxay model use 2', 'dgxay model add gpt-4o --name GPT-4o', 'dgxay model fetch'],
  run
};
