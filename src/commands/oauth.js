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
  { name: 'client-secret', type: 'string', valueName: 'secret', desc: 'OAuth Client Secret (optional)' },
  { name: 'authorize-url', type: 'string', valueName: 'url', desc: 'Authorize endpoint' },
  { name: 'token-url', type: 'string', valueName: 'url', desc: 'Token endpoint' },
  { name: 'scopes', type: 'string', valueName: 'text', desc: 'Permission scope' },
  { name: 'code', type: 'string', valueName: 'code', desc: 'Manual flow: submit the auth code directly (code#state)' },
  { name: 'no-browser', type: 'boolean', desc: 'Do not open the browser, only print the authorize link' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: 'Skip confirmation' }
];

function formatExpiry(ts) {
  if (!ts) return 'never expires';
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

function list() {
  const providers = oauth.listProviders();
  print.blank();
  print.heading('Account connections');
  const rows = providers.map((item) => {
    const connection = item.connection;
    const status = !connection ? 'not connected' : connection.expired ? 'expired' : 'connected';
    const tone = !connection ? (value) => value : connection.expired ? COLORS.yellow : COLORS.green;
    return [
      item.id,
      item.name,
      item.subtitle,
      tone(status),
      connection?.account || '',
      connection ? formatExpiry(connection.expiresAt) : '',
      item.redirectMode === 'manual' ? 'manual auth code' : 'system browser'
    ];
  });
  print.table(
    [
      { title: 'ID', max: 10 },
      { title: 'Platform', max: 10 },
      { title: 'Account type', max: 24 },
      { title: 'Status', max: 8 },
      { title: 'Account', max: 28 },
      { title: 'Expires', max: 18 },
      { title: 'Auth method', max: 12 }
    ],
    rows
  );
  print.blank();
  print.hint('dgxay oauth connect <platform> to connect · dgxay oauth disconnect <platform> to disconnect');
  print.hint('After connecting, enable OAuth on a provider: dgxay provider edit <name> --oauth-provider <platform>');
  print.blank();
  return 0;
}

async function connect(id, opts) {
  const def = oauth.PROVIDERS[id];
  if (!def) {
    print.fail(`Unsupported platform: ${id} (choose openai / anthropic / xai / google)`);
    return 1;
  }
  const current = oauth.listProviders().find((item) => item.id === id);
  if (current.connection && !current.connection.expired && !opts.yes && process.stdin.isTTY) {
    const answer = await ask(`${def.name} is already connected (${current.connection.account}). Re-authorizing overwrites the existing token. Continue? [y/N] `);
    if (!/^y/i.test(String(answer || '').trim())) {
      print.hint('Cancelled');
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
      print.hint(`Google requires a desktop-app OAuth client first: dgxay oauth client google --client-id <ID>`);
    }
    return 1;
  }

  print.blank();
  print.heading(`Connect ${def.name}`);
  print.hint(def.hint);
  print.blank();
  if (flow.browserOpened) print.ok('Opened the system browser; complete authorization in the browser');
  else {
    print.warn('Could not open the browser automatically; open the link below manually:');
  }
  print.blank();
  process.stdout.write(`${COLORS.cyan(flow.authUrl)}\n`);
  print.blank();

  if (flow.mode === 'manual') {
    print.write('After authorizing in the browser, copy the auth code (like code#state) and paste it here:');
    let code = opts.code;
    if (!code) {
      if (!process.stdin.isTTY) {
        print.fail('In non-interactive environments use --code <auth code>');
        return 1;
      }
      code = await ask('Auth code: ');
    }
    if (!code) {
      print.fail('Auth code is empty');
      return 1;
    }
    try {
      const connection = await oauth.complete(flow.id, code);
      print.ok(`${def.name} account connected: ${connection.account}`);
      return 0;
    } catch (err) {
      print.fail(err.message || 'Authorization failed');
      return 1;
    }
  }

  process.stdout.write(`${COLORS.faint('Waiting for the browser callback to finish authorization... (Ctrl+C to cancel)')}\n`);
  try {
    const connection = await oauth.wait(flow.id);
    print.blank();
    print.ok(`${def.name} account connected: ${connection.account}`);
    print.hint('Enable it on a provider: dgxay provider edit <name> --oauth-provider ' + id);
    return 0;
  } catch (err) {
    print.fail(err.message || 'Authorization failed');
    return 1;
  }
}

function disconnect(id, opts) {
  const def = oauth.PROVIDERS[id];
  if (!def) {
    print.fail(`Unsupported platform: ${id}`);
    return 1;
  }
  const current = oauth.listProviders().find((item) => item.id === id);
  if (!current?.connection) {
    print.warn(`${def.name} is not connected`);
    return 1;
  }
  oauth.disconnect(id);
  print.ok(`Disconnected ${def.name} account (${current.connection.account})`);
  print.hint('Providers using this account cannot make requests until you reconnect or switch to an API Key');
  return 0;
}

function saveClient(id, opts) {
  const def = oauth.PROVIDERS[id];
  if (!def) {
    print.fail(`Unsupported platform: ${id}`);
    return 1;
  }
  const patch = {};
  for (const key of ['clientId', 'clientSecret', 'authorizeUrl', 'tokenUrl', 'scopes']) {
    if (opts[key] !== undefined) patch[key] = opts[key];
  }
  if (!Object.keys(patch).length) {
    const current = oauth.listProviders().find((item) => item.id === id);
    print.blank();
    print.heading(`${def.name} OAuth client`);
    print.keyValue([
      { label: 'Client ID', value: current.clientId ? `${current.clientId.slice(0, 8)}…` : '(empty)' },
      { label: 'Client Secret', value: current.hasSecret ? 'set' : 'not set' },
      { label: 'Authorize endpoint', value: current.authorizeUrl },
      { label: 'Token endpoint', value: current.tokenUrl },
      { label: 'Permission scope', value: current.scopes },
      { label: 'Redirect URI', value: current.redirectUri }
    ]);
    print.blank();
    print.hint(`Modify: dgxay oauth client ${id} --client-id <ID> [--client-secret <Secret>]`);
    print.blank();
    return 0;
  }
  try {
    const saved = oauth.saveClient(id, patch);
    print.ok(`Saved OAuth client config for ${def.name}`);
    print.hint(`You can connect now: dgxay oauth connect ${saved.id}`);
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
    if (!target) throw Object.assign(new Error('Usage: dgxay oauth connect <openai|anthropic|xai|google>'), { userError: true });
    return connect(target, opts);
  }
  if (action === 'disconnect' || action === 'logout') {
    if (!target) throw Object.assign(new Error('Usage: dgxay oauth disconnect <platform>'), { userError: true });
    return disconnect(target, opts);
  }
  if (action === 'client') {
    if (!target) throw Object.assign(new Error('Usage: dgxay oauth client <platform> [--client-id ...]'), { userError: true });
    return saveClient(target, opts);
  }
  print.fail(`Unknown subcommand: ${action}`);
  print.hint('Available: list / connect / disconnect / client');
  return 1;
}

module.exports = {
  name: 'oauth',
  aliases: ['account'],
  summary: 'OAuth account connections',
  usage: 'dgxay oauth <list|connect|disconnect|client>',
  options,
  subcommands: [
    ['list', 'View connection status per platform'],
    ['connect <platform>', 'Connect (system browser + PKCE)'],
    ['disconnect <platform>', 'Disconnect and delete the local token'],
    ['client <platform>', 'View / modify OAuth client config']
  ],
  examples: ['dgxay oauth list', 'dgxay oauth connect anthropic', 'dgxay oauth client google --client-id xxx.apps.googleusercontent.com'],
  run
};
