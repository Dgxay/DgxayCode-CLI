'use strict';

/**
 * oauth：账户连接（对应桌面版「设置 → 账户连接」）。
 *
 *   dgxay oauth list
 *   dgxay oauth connect <openai|anthropic|xai|google>
 *   dgxay oauth disconnect <平台>
 *   dgxay oauth client <平台> [--client-id X] [--client-secret Y] [--authorize-url U] [--token-url U] [--scopes S]
 *
 * 说明：CLI 用系统浏览器发起授权；Anthropic 需要把浏览器显示的 code#state 粘贴回来。
 */

const print = require('../cli/print');
const { parseArgs, actionFirst } = require('../cli/args');
const { COLORS } = require('../cli/ansi');
const oauth = require('../core/oauth');
const { ask } = require('../services/input');

const options = [
  { name: 'client-id', type: 'string', valueName: 'id', desc: 'OAuth Client ID' },
  { name: 'client-secret', type: 'string', valueName: 'secret', desc: 'OAuth Client Secret（可选）' },
  { name: 'authorize-url', type: 'string', valueName: 'url', desc: '授权端点' },
  { name: 'token-url', type: 'string', valueName: 'url', desc: '令牌端点' },
  { name: 'scopes', type: 'string', valueName: 'text', desc: '权限范围' },
  { name: 'code', type: 'string', valueName: 'code', desc: '手动流程：直接提交授权码（code#state）' },
  { name: 'no-browser', type: 'boolean', desc: '不自动打开浏览器，只打印授权链接' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: '跳过确认' }
];

function formatExpiry(ts) {
  if (!ts) return '长期有效';
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

function list() {
  const providers = oauth.listProviders();
  print.blank();
  print.heading('账户连接');
  const rows = providers.map((item) => {
    const connection = item.connection;
    const status = !connection ? '未连接' : connection.expired ? '已过期' : '已连接';
    const tone = !connection ? (value) => value : connection.expired ? COLORS.yellow : COLORS.green;
    return [
      item.id,
      item.name,
      item.subtitle,
      tone(status),
      connection?.account || '',
      connection ? formatExpiry(connection.expiresAt) : '',
      item.redirectMode === 'manual' ? '手动授权码' : '系统浏览器'
    ];
  });
  print.table(
    [
      { title: 'ID', max: 10 },
      { title: '平台', max: 10 },
      { title: '账户类型', max: 24 },
      { title: '状态', max: 8 },
      { title: '账号', max: 28 },
      { title: '有效期', max: 18 },
      { title: '授权方式', max: 12 }
    ],
    rows
  );
  print.blank();
  print.hint('dgxay oauth connect <平台> 连接 · dgxay oauth disconnect <平台> 断开');
  print.hint('连接后可在供应商中使用 OAuth：dgxay provider edit <名称> --oauth-provider <平台>');
  print.blank();
  return 0;
}

async function connect(id, opts) {
  const def = oauth.PROVIDERS[id];
  if (!def) {
    print.fail(`不支持的平台：${id}（可选 openai / anthropic / xai / google）`);
    return 1;
  }
  const current = oauth.listProviders().find((item) => item.id === id);
  if (current.connection && !current.connection.expired && !opts.yes && process.stdin.isTTY) {
    const answer = await ask(`${def.name} 已连接（${current.connection.account}）。重新授权会覆盖现有令牌，继续？[y/N] `);
    if (!/^y/i.test(String(answer || '').trim())) {
      print.hint('已取消');
      return 1;
    }
  }

  if (opts.noBrowser) process.env.DGXAY_OAUTH_NO_BROWSER = '1';

  let flow;
  try {
    flow = await oauth.begin({ provider: id });
  } catch (err) {
    print.fail(err.message);
    if (/Client ID/i.test(err.message)) {
      print.hint(`Google 需要先创建桌面应用 OAuth 客户端：dgxay oauth client google --client-id <ID>`);
    }
    return 1;
  }

  print.blank();
  print.heading(`连接 ${def.name}`);
  print.hint(def.hint);
  print.blank();
  if (flow.browserOpened) print.ok('已打开系统浏览器，请在浏览器中完成授权');
  else {
    print.warn('无法自动打开浏览器，请手动访问下面的链接：');
  }
  print.blank();
  process.stdout.write(`${COLORS.cyan(flow.authUrl)}\n`);
  print.blank();

  if (flow.mode === 'manual') {
    print.write('浏览器授权后会显示一段授权码（形如 code#state），把它粘贴到这里：');
    let code = opts.code;
    if (!code) {
      if (!process.stdin.isTTY) {
        print.fail('非交互环境请使用 --code <授权码>');
        return 1;
      }
      code = await ask('授权码: ');
    }
    if (!code) {
      print.fail('授权码为空');
      return 1;
    }
    try {
      const connection = await oauth.complete(flow.id, code);
      print.ok(`${def.name} 账户已连接：${connection.account}`);
      return 0;
    } catch (err) {
      print.fail(err.message || '授权失败');
      return 1;
    }
  }

  process.stdout.write(`${COLORS.faint('等待浏览器回调完成授权…（Ctrl+C 取消）')}\n`);
  try {
    const connection = await oauth.wait(flow.id);
    print.blank();
    print.ok(`${def.name} 账户已连接：${connection.account}`);
    print.hint('在供应商里启用：dgxay provider edit <名称> --oauth-provider ' + id);
    return 0;
  } catch (err) {
    print.fail(err.message || '授权失败');
    return 1;
  }
}

function disconnect(id, opts) {
  const def = oauth.PROVIDERS[id];
  if (!def) {
    print.fail(`不支持的平台：${id}`);
    return 1;
  }
  const current = oauth.listProviders().find((item) => item.id === id);
  if (!current?.connection) {
    print.warn(`${def.name} 尚未连接`);
    return 1;
  }
  oauth.disconnect(id);
  print.ok(`已断开 ${def.name} 账户（${current.connection.account}）`);
  print.hint('使用该账户的供应商将无法请求，直到重新连接或改用 API Key');
  return 0;
}

function saveClient(id, opts) {
  const def = oauth.PROVIDERS[id];
  if (!def) {
    print.fail(`不支持的平台：${id}`);
    return 1;
  }
  const patch = {};
  for (const key of ['clientId', 'clientSecret', 'authorizeUrl', 'tokenUrl', 'scopes']) {
    if (opts[key] !== undefined) patch[key] = opts[key];
  }
  if (!Object.keys(patch).length) {
    const current = oauth.listProviders().find((item) => item.id === id);
    print.blank();
    print.heading(`${def.name} OAuth 客户端`);
    print.keyValue([
      { label: 'Client ID', value: current.clientId ? `${current.clientId.slice(0, 8)}…` : '（空）' },
      { label: 'Client Secret', value: current.hasSecret ? '已设置' : '未设置' },
      { label: '授权端点', value: current.authorizeUrl },
      { label: '令牌端点', value: current.tokenUrl },
      { label: '权限范围', value: current.scopes },
      { label: '回调地址', value: current.redirectUri }
    ]);
    print.blank();
    print.hint(`修改：dgxay oauth client ${id} --client-id <ID> [--client-secret <Secret>]`);
    print.blank();
    return 0;
  }
  try {
    const saved = oauth.saveClient(id, patch);
    print.ok(`已保存 ${def.name} 的 OAuth 客户端配置`);
    print.hint(`现在可以连接：dgxay oauth connect ${saved.id}`);
    return 0;
  } catch (err) {
    print.fail(err.message);
    return 1;
  }
}

async function run({ argv }) {
  const { action: rawAction, rest, options: opts } = actionFirst(argv, options);
  const action = rawAction || 'list';
  const target = rest[0];

  if (action === 'list' || action === 'ls') return list();
  if (action === 'connect' || action === 'login') {
    if (!target) throw Object.assign(new Error('用法：dgxay oauth connect <openai|anthropic|xai|google>'), { userError: true });
    return connect(target, opts);
  }
  if (action === 'disconnect' || action === 'logout') {
    if (!target) throw Object.assign(new Error('用法：dgxay oauth disconnect <平台>'), { userError: true });
    return disconnect(target, opts);
  }
  if (action === 'client') {
    if (!target) throw Object.assign(new Error('用法：dgxay oauth client <平台> [--client-id ...]'), { userError: true });
    return saveClient(target, opts);
  }
  print.fail(`未知子命令：${action}`);
  print.hint('可用：list / connect / disconnect / client');
  return 1;
}

module.exports = {
  name: 'oauth',
  aliases: ['account'],
  summary: 'OAuth 账户连接',
  usage: 'dgxay oauth <list|connect|disconnect|client>',
  options,
  subcommands: [
    ['list', '查看各平台连接状态'],
    ['connect <平台>', '连接（系统浏览器 + PKCE）'],
    ['disconnect <平台>', '断开并删除本地令牌'],
    ['client <平台>', '查看 / 修改 OAuth 客户端配置']
  ],
  examples: ['dgxay oauth list', 'dgxay oauth connect anthropic', 'dgxay oauth client google --client-id xxx.apps.googleusercontent.com'],
  run
};
