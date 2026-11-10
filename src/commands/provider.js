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
  { name: 'name', type: 'string', valueName: 'text', desc: '供应商名称' },
  { name: 'protocol', type: 'string', valueName: 'p', desc: 'openai / anthropic / responses' },
  { name: 'base-url', type: 'string', valueName: 'url', desc: '接口地址' },
  { name: 'api-key', type: 'string', valueName: 'key', desc: 'API Key' },
  { name: 'model', type: 'list', valueName: 'id', desc: '模型 ID（可重复或逗号分隔）' },
  { name: 'oauth-provider', type: 'string', valueName: 'id', desc: '使用已连接的 OAuth 账户' },
  { name: 'review-model', type: 'string', valueName: 'id', desc: '自动审查模型 ID' },
  { name: 'context-window', type: 'number', valueName: 'n', desc: '上下文窗口（可选）' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: '跳过确认' }
];

function list() {
  const config = settings.readConfig();
  const providers = config.providers || [];
  print.blank();
  if (!providers.length) {
    print.hint('还没有供应商。运行 dgxay provider add 或 dgxay config init');
    print.blank();
    return 0;
  }
  print.heading(`供应商（${providers.length}）`);
  const rows = providers.map((provider, index) => [
    String(index + 1),
    index === 0 ? COLORS.accent('默认') : '',
    provider.id === config.activeProviderId ? COLORS.green('当前') : '',
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
      { title: '名称', max: 16 },
      { title: '协议', max: 16 },
      { title: 'Base URL', max: 40 },
      { title: '模型', max: 30 },
      { title: '审查模型', max: 18 },
      { title: '认证', max: 16 }
    ],
    rows
  );
  print.blank();
  print.hint('供应商顺序有意义：第一个是默认供应商，也是未配置审查模型时的回退来源');
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
      const answer = await ask('协议 [1] OpenAI ChatCompletions  [2] Anthropic Messages  [3] OpenAI Responses : ');
      const index = Number(String(answer || '').trim()) || 1;
      protocol = ['openai', 'anthropic', 'responses'][index - 1] || 'openai';
    }
    if (!baseUrl) {
      const answer = await ask(`Base URL [${settings.PROTOCOL_META[protocol].basePlaceholder}]: `);
      baseUrl = String(answer || '').trim() || settings.PROTOCOL_META[protocol].basePlaceholder;
    }
    if (!name) {
      const answer = await ask('供应商名称: ');
      name = String(answer || '').trim();
    }
    if (!oauthProvider && apiKey === undefined) {
      const secret = await askSecret('API Key（本地模型可留空）: ');
      apiKey = secret === null ? undefined : secret;
    }
    if (!models.length) {
      const answer = await ask('模型 ID（多个用逗号分隔）: ');
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
  print.ok(`已添加供应商「${result.provider.name}」（${result.provider.id}）`);
  return 0;
}

function edit(ref, opts) {
  const provider = settings.findProvider(ref);
  if (!provider) {
    print.fail(`找不到供应商：${ref}`);
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
  print.ok(`已更新供应商「${result.provider.name}」`);
  return 0;
}

async function remove(ref, opts) {
  const provider = settings.findProvider(ref);
  if (!provider) {
    print.fail(`找不到供应商：${ref}`);
    return 1;
  }
  if (!opts.yes && process.stdin.isTTY) {
    const ok = await confirm(`删除供应商「${provider.name}」及其密钥？`, false);
    if (!ok) {
      print.hint('已取消');
      return 1;
    }
  }
  const config = settings.removeProvider(provider.id);
  print.ok(`已删除「${provider.name}」`);
  if (!config.providers?.length) print.hint('已经没有供应商了，运行 dgxay config init 重新配置');
  else if (config.activeProviderId !== settings.readConfig().activeProviderId) {
    print.hint(`当前供应商已切换为「${(config.providers || []).find((p) => p.id === config.activeProviderId)?.name || '未知'}」`);
  }
  return 0;
}

function use(ref) {
  const provider = settings.findProvider(ref);
  if (!provider) {
    print.fail(`找不到供应商：${ref}`);
    return 1;
  }
  const model = provider.models?.[0];
  if (!model) {
    print.fail(`供应商 ${provider.name} 没有模型`);
    return 1;
  }
  settings.saveConfig({ activeProviderId: provider.id, activeModelId: model.id });
  print.ok(`当前供应商：${provider.name} / ${model.name || model.id}`);
  return 0;
}

function review(ref, opts) {
  const provider = settings.findProvider(ref);
  if (!provider) {
    print.fail(`找不到供应商：${ref}`);
    return 1;
  }
  if (opts.reviewModel === undefined) {
    const model = (provider.models || []).find((m) => m.id === provider.reviewModelId);
    if (model) print.write(`${provider.name} 的审查模型：${model.name || model.id}（${model.id}）`);
    else print.write(`${provider.name} 未配置审查模型，自动审查时会回退到默认供应商`);
    return 0;
  }
  const models = provider.models || [];
  const target = models.find((m) => m.id === opts.reviewModel);
  if (opts.reviewModel && !target) {
    print.fail(`供应商 ${provider.name} 下没有模型 ${opts.reviewModel}`);
    print.hint(`可用：${models.map((m) => m.id).join(', ')}`);
    return 1;
  }
  const next = (settings.readConfig().providers || []).map((p) =>
    p.id === provider.id ? { ...p, reviewModelId: target ? target.id : '' } : p
  );
  settings.saveConfig({ providers: next });
  if (target) {
    print.ok(`${provider.name} 的自动审查模型：${target.name || target.id}`);
    print.hint('现在可以在 /permission 中选择「自动审查」');
  } else {
    print.ok(`已清除 ${provider.name} 的审查模型`);
  }
  return 0;
}

function move(ref, direction) {
  const dir = direction === 'up' || direction === 'u' || direction === '-1' ? -1 : 1;
  settings.moveProvider(ref, dir);
  print.ok(`已${dir < 0 ? '上移' : '下移'}「${settings.findProvider(ref)?.name || ref}」`);
  return list();
}

function oauthAccounts() {
  const list = oauth.listProviders();
  print.blank();
  print.heading('OAuth 账户');
  const rows = list.map((item) => [
    item.name,
    item.subtitle,
    item.connection && !item.connection.expired
      ? COLORS.green('已连接')
      : item.connection?.expired
        ? COLORS.yellow('已过期')
        : '未连接',
    item.connection?.account || '',
    item.redirectMode === 'manual' ? '手动授权码' : '系统浏览器'
  ]);
  print.table(
    [
      { title: '平台', max: 12 },
      { title: '账户类型', max: 24 },
      { title: '状态', max: 8 },
      { title: '账号', max: 30 },
      { title: '授权方式', max: 12 }
    ],
    rows
  );
  print.blank();
  print.hint('dgxay oauth connect <平台> 连接账户；连接后可用 dgxay provider add --oauth-provider <平台>');
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
      if (!rest[0]) throw Object.assign(new Error('用法：dgxay provider edit <名称> [选项]'), { userError: true });
      return edit(rest[0], opts);
    }
    case 'rm':
    case 'remove':
    case 'delete': {
      if (!rest[0]) throw Object.assign(new Error('用法：dgxay provider rm <名称>'), { userError: true });
      return remove(rest[0], opts);
    }
    case 'use': {
      if (!rest[0]) throw Object.assign(new Error('用法：dgxay provider use <名称>'), { userError: true });
      return use(rest[0]);
    }
    case 'mv':
    case 'move': {
      if (!rest[0]) throw Object.assign(new Error('用法：dgxay provider mv <名称> up|down'), { userError: true });
      return move(rest[0], rest[1] || 'down');
    }
    case 'review': {
      if (!rest[0]) {
        const config = settings.readConfig();
        const rows = (config.providers || []).map((p) => [p.name, p.reviewModelId || '（未配置）']);
        print.blank();
        print.table(
          [
            { title: '供应商', max: 20 },
            { title: '审查模型', max: 30 }
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
      print.fail(`未知子命令：${action}`);
      print.hint('可用：list / add / edit / rm / use / mv / review / oauth');
      return 1;
  }
}

module.exports = {
  name: 'provider',
  aliases: ['prov'],
  summary: '供应商与审查模型管理',
  usage: 'dgxay provider <list|add|edit|rm|use|mv|review>',
  options,
  subcommands: [
    ['list', '列出所有供应商'],
    ['add', '新增供应商'],
    ['edit <名称>', '修改供应商'],
    ['rm <名称>', '删除供应商'],
    ['use <名称>', '设为当前供应商'],
    ['mv <名称> up|down', '调整顺序'],
    ['review [名称] [--model id]', '查看 / 设置自动审查模型']
  ],
  examples: [
    'dgxay provider list',
    'dgxay provider add --name DeepSeek --base-url https://api.deepseek.com/v1 --model deepseek-chat',
    'dgxay provider add --oauth-provider openai --base-url https://api.openai.com/v1 --model gpt-5',
    'dgxay provider review DeepSeek --model deepseek-chat'
  ],
  run
};
