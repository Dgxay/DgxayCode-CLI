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
  { name: '通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Moonshot', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: 'Ollama 本地', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' }
];

const options = [
  { name: 'protocol', type: 'string', valueName: 'p', desc: 'openai / anthropic / responses' },
  { name: 'name', type: 'string', valueName: 'text', desc: '供应商名称' },
  { name: 'base-url', type: 'string', valueName: 'url', desc: '接口地址' },
  { name: 'api-key', type: 'string', valueName: 'key', desc: 'API Key（也可用 DGXAY_API_KEY 环境变量）' },
  { name: 'model', type: 'list', valueName: 'id', desc: '模型 ID，可重复指定或逗号分隔' },
  { name: 'oauth-provider', type: 'string', valueName: 'id', desc: '改用已连接的 OAuth 账户：openai/anthropic/xai/google' },
  { name: 'force', alias: 'f', type: 'boolean', desc: '已有配置时仍然覆盖' }
];

/* ------------------------------ init ------------------------------ */

async function promptProtocol(config) {
  const interactive = process.stdin.isTTY;
  if (!interactive) return 'openai';
  print.blank();
  print.heading('接口协议');
  const list = ['openai', 'anthropic', 'responses'];
  list.forEach((key, index) => {
    const meta = settings.PROTOCOL_META[key];
    print.write(`  ${COLORS.accent(String(index + 1))}. ${meta.full} ${COLORS.faint(meta.path)}`);
  });
  const answer = await ask(`选择 [1-3，默认 1]: `);
  const index = Number(String(answer || '').trim());
  if (Number.isInteger(index) && index >= 1 && index <= 3) return list[index - 1];
  return 'openai';
}

async function promptPreset(protocol) {
  const interactive = process.stdin.isTTY;
  if (!interactive) return null;
  print.blank();
  print.heading('快速预设');
  const matches = PRESETS.filter((preset) => preset.protocol === protocol);
  matches.forEach((preset, index) => {
    print.write(`  ${COLORS.accent(String(index + 1))}. ${preset.name} ${COLORS.faint(preset.baseUrl)}`);
  });
  print.write(`  ${COLORS.faint('直接回车跳过，手动填写')}`);
  const answer = await ask('选择预设: ');
  const index = Number(String(answer || '').trim());
  if (Number.isInteger(index) && index >= 1 && index <= matches.length) return matches[index - 1];
  return null;
}

async function runInit(opts, runtime) {
  const config = settings.readConfig();
  if (config.providers?.length && !opts.force) {
    print.warn(`已经配置了 ${config.providers.length} 个供应商。要追加新的供应商请使用 dgxay provider add`);
    print.hint('如需重新初始化首个供应商，加 --force');
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
    print.write(`${COLORS.bold('DgxayCode 首次配置')} ${COLORS.faint(`v${VERSION}`)}`);
    print.write(COLORS.faint('配置会写入本机数据目录，密钥仅保存在本地，不会上传。'));
    print.write(COLORS.faint(`数据目录：${cfg.DCB_DIR}`));

    protocol = protocol || (await promptProtocol(config));
    const preset = await promptPreset(protocol);
    if (preset) {
      name = name || preset.name;
      baseUrl = baseUrl || preset.baseUrl;
      models = models.length ? models : [preset.model];
      print.write(COLORS.faint(`已选择 ${preset.name}，Base URL 预填 ${preset.baseUrl}`));
    }

    if (!name) {
      const answer = await ask(`供应商名称 [${preset?.name || '我的供应商'}]: `);
      name = String(answer || '').trim() || preset?.name || '我的供应商';
    }
    if (!baseUrl) {
      const answer = await ask(`Base URL [${settings.PROTOCOL_META[protocol].basePlaceholder}]: `);
      baseUrl = String(answer || '').trim() || settings.PROTOCOL_META[protocol].basePlaceholder;
    }

    const useOauth = await confirm('使用已连接的 OAuth 账户（而不是 API Key）？', false);
    if (useOauth) {
      const connected = oauth.listProviders().filter((item) => item.connection && !item.connection.expired);
      if (!connected.length) {
        print.warn('还没有可用账户，先继续填写 API Key。可稍后运行 dgxay oauth connect <平台>');
      } else {
        connected.forEach((item, index) =>
          print.write(`  ${COLORS.accent(String(index + 1))}. ${item.name} ${COLORS.faint(item.connection.account)}`)
        );
        const answer = await ask('选择账户 [1]: ');
        const index = Number(String(answer || '').trim()) || 1;
        oauthProvider = connected[index - 1]?.id || '';
      }
    }

    if (!oauthProvider && !apiKey) {
      const secret = await askSecret('API Key（本地模型可留空）: ');
      apiKey = secret !== null ? secret : '';
    }
    if (!models.length) {
      const answer = await ask(`模型 ID [${settings.PROTOCOL_META[protocol].modelPlaceholder}]: `);
      models = String(answer || '')
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (!models.length) {
      print.fail('模型 ID 不能为空');
      return 1;
    }
  }

  if (!protocol) protocol = 'openai';
  if (!baseUrl) baseUrl = settings.PROTOCOL_META[protocol].basePlaceholder;
  if (!models.length) {
    throw Object.assign(new Error('缺少 --model，例如 --model deepseek-chat'), { userError: true });
  }
  if (!apiKey && !oauthProvider) {
    print.warn('没有填写 API Key：本地模型（Ollama 等）可以忽略，云端接口会返回 401');
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
  print.ok(`已保存供应商「${result.provider.name}」（${settings.PROTOCOL_META[result.provider.protocol].full}）`);
  print.keyValue([
    { label: 'Base URL', value: result.provider.baseUrl },
    { label: '模型', value: result.provider.models.map((m) => m.id).join(', ') },
    { label: '自动审查模型', value: result.provider.reviewModelId || '未配置' },
    { label: '认证方式', value: oauthProvider ? `OAuth · ${oauthProvider}` : apiKey ? 'API Key' : '无（本地模型）' },
    { label: '配置文件', value: settings.homeRelative(cfg.CONFIG_PATH) }
  ]);
  print.blank();
  print.hint('下一步：dgxay doctor 检查连通性，然后直接运行 dgxay 开始对话');
  void interactive;
  void runtime;
  return 0;
}

/* ------------------------------ show / get / set / path / reset ------------------------------ */

function runShow() {
  const config = settings.readConfig();
  const provider = settings.activeProvider(config);
  const model = settings.activeModel(config);
  print.heading('当前配置');
  print.keyValue(
    [
      { label: '数据目录', value: settings.homeRelative(cfg.DCB_DIR) },
      { label: '配置文件', value: settings.homeRelative(cfg.CONFIG_PATH) },
      { label: '模式', value: config.ui?.mode === 'work' ? '工作模式' : '对话模式' },
      {
        label: '权限',
        value: `${settings.PERMISSIONS[settings.currentPermission(config)].label}${
          config.ui?.permission === 'auto' && !settings.hasReviewModel(config) ? '（审查模型缺失，已回退普通权限）' : ''
        }`
      },
      { label: '工作空间', value: config.work?.workspace || '（未选择）' },
      { label: '当前供应商', value: provider ? `${provider.name}（${provider.id}）` : '未配置' },
      { label: '当前模型', value: model ? `${model.name}${model.id !== model.name ? `（${model.id}）` : ''}` : '未配置' },
      { label: '发送方式', value: config.chat?.stream === false ? '非流式' : '流式' },
      { label: '温度', value: String(config.chat?.temperature ?? 0.7) },
      { label: '最大输出', value: String(config.chat?.maxTokens ?? 4096) },
      { label: '自定义指令', value: config.chat?.systemPrompt ? '已设置' : '未设置' }
    ],
    {}
  );
  print.blank();
  print.heading('供应商');
  if (!config.providers?.length) {
    print.hint('  还没有供应商，运行 dgxay config init');
    return 0;
  }
  const rows = config.providers.map((item, index) => [
    String(index + 1),
    item.name,
    settings.PROTOCOL_META[item.protocol || 'openai'].short,
    item.baseUrl,
    item.authMode === 'oauth' ? `OAuth(${item.oauthProvider || '?'})` : item.apiKey ? cfg.maskKey(item.apiKey) : '无',
    (item.models || []).length,
    item.reviewModelId || '-'
  ]);
  print.table(
    [
      { title: '#', max: 3 },
      { title: '名称', max: 18 },
      { title: '协议', max: 16 },
      { title: 'Base URL', max: 40 },
      { title: '认证', max: 16 },
      { title: '模型数', max: 5 },
      { title: '审查模型', max: 20 }
    ],
    rows
  );
  print.blank();
  print.hint('添加/修改供应商：dgxay provider --help');
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
    if (!rest[0]) throw Object.assign(new Error('请指定配置键，例如 dgxay config get ui.permission'), { userError: true });
    const value = getPath(settings.readConfig(), rest[0]);
    if (value === undefined) {
      print.fail(`没有这个配置项：${rest[0]}`);
      return 1;
    }
    process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    return 0;
  }

  if (action === 'set') {
    const key = rest[0];
    const raw = rest.slice(1).join(' ');
    if (!key || !raw) {
      throw Object.assign(new Error('用法：dgxay config set <键> <值>，例如 dgxay config set chat.temperature 0.3'), {
        userError: true
      });
    }
    const allowed = ['ui.permission', 'ui.mode', 'chat.temperature', 'chat.maxTokens', 'chat.stream', 'chat.systemPrompt'];
    if (!allowed.includes(key)) {
      throw Object.assign(new Error(`不支持修改 ${key}。可修改：${allowed.join(', ')}`), { userError: true });
    }
    let value = raw;
    if (key === 'chat.temperature' || key === 'chat.maxTokens') value = Number(raw);
    if (!Number.isFinite(value) && typeof value === 'number') {
      throw Object.assign(new Error('需要数字'), { userError: true });
    }
    if (key === 'chat.stream') value = !/^(false|0|no|off)$/i.test(raw);
    if (key === 'ui.permission' && !settings.PERMISSIONS[raw]) {
      throw Object.assign(new Error('权限只能是 none / normal / auto / full'), { userError: true });
    }
    const [section, name] = key.split('.');
    settings.saveConfig({ [section]: { [name]: value } });
    print.ok(`${key} = ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    return 0;
  }

  if (action === 'path') {
    const paths = settings.paths();
    print.keyValue([
      { label: '数据目录', value: paths.dataDir },
      { label: '配置文件', value: paths.config },
      { label: '对话记录', value: paths.chats },
      { label: 'OAuth', value: paths.oauth },
      { label: 'MCP', value: paths.mcp },
      { label: '技能目录', value: paths.skills }
    ]);
    return 0;
  }

  if (action === 'reset') {
    const yes =
      argv.includes('--yes') ||
      (await confirm('将重置全部配置（供应商、密钥、偏好），对话记录也会清空。继续？', false));
    if (!yes) {
      print.hint('已取消');
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
    print.ok('配置已重置');
    print.hint('oauth.json、mcp.json 与 skills/ 不会被删除；如需彻底清理请手动删除数据目录');
    if (fs.existsSync(backup)) print.hint(`原配置已备份到 ${path.basename(backup)}`);
    return 0;
  }

  print.fail(`未知的 config 子命令：${action}`);
  print.hint('可用：init / show / get / set / path / reset');
  return 1;
}

module.exports = {
  name: 'config',
  aliases: ['cfg'],
  summary: '配置：初始化、查看、修改数据目录',
  usage: 'dgxay config <init|show|get|set|path|reset>',
  options,
  subcommands: [
    ['init', '首次配置供应商与模型'],
    ['show', '查看当前配置（密钥打码）'],
    ['get <键>', '读取单项配置'],
    ['set <键> <值>', '修改单项配置'],
    ['path', '显示数据目录与文件路径'],
    ['reset', '重置配置（保留 OAuth / MCP / 技能）']
  ],
  examples: ['dgxay config init', 'dgxay config show', 'dgxay config set chat.temperature 0.3', 'dgxay config path'],
  run,
  runCmd,
  getPath
};
