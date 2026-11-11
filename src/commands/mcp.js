'use strict';

/**
 * mcp：MCP Server 管理（对应桌面版「设置 → MCP」）。
 *
 *   dgxay mcp list
 *   dgxay mcp add --name filesystem --command npx --args "-y @modelcontextprotocol/server-filesystem ."
 *   dgxay mcp start <名称|ID>
 *   dgxay mcp stop <名称|ID>
 *   dgxay mcp logs <名称|ID>
 *   dgxay mcp rm <名称|ID>
 *   dgxay mcp env <名称|ID> --env "KEY=value"    追加环境变量
 *
 * 注意：与桌面版一致，当前版本只管理进程，不把 MCP 工具暴露给模型。
 */

const print = require('../cli/print');
const { parseArgs, actionFirst } = require('../cli/args');
const { COLORS } = require('../cli/ansi');
const mcp = require('../core/mcp');
const cfg = require('../services/config');
const { ask } = require('../services/input');

const options = [
  { name: 'name', type: 'string', valueName: 'text', desc: 'Display name' },
  { name: 'command', type: 'string', valueName: 'cmd', desc: 'Start command (e.g. npx / uvx)' },
  { name: 'args', type: 'string', valueName: 'text', desc: 'Command arguments' },
  { name: 'env', type: 'list', valueName: 'K=V', desc: 'Environment variables, repeatable' },
  { name: 'cwd', type: 'string', valueName: 'dir', desc: 'Working directory' },
  { name: 'follow', alias: 'f', type: 'boolean', desc: 'logs: keep streaming output' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: 'Skip confirmation' }
];

function statusText(status) {
  if (status === 'running') return COLORS.green('running');
  if (status === 'error') return COLORS.red('error');
  if (status === 'stopping') return COLORS.yellow('stopping');
  return COLORS.faint('stopped');
}

function list() {
  const servers = mcp.listServers();
  print.blank();
  if (!servers.length) {
    print.hint(`No MCP servers yet (config is stored in ${cfg.MCP_PATH})`);
    print.hint('Add: dgxay mcp add --name filesystem --command npx --args "-y @modelcontextprotocol/server-filesystem ."');
    print.blank();
    return 0;
  }
  print.heading(`MCP servers (${servers.length})`);
  const rows = servers.map((server, index) => [
    String(index + 1),
    server.name,
    statusText(server.status),
    server.pid ? String(server.pid) : '',
    `${server.command} ${(server.args || []).join(' ')}`.trim(),
    server.cwd || ''
  ]);
  print.table(
    [
      { title: '#', max: 3 },
      { title: 'Name', max: 20 },
      { title: 'Status', max: 8 },
      { title: 'PID', max: 7 },
      { title: 'Command', max: 50 },
      { title: 'Working dir', max: 30 }
    ],
    rows
  );
  print.blank();
  print.hint('MCP servers do not start with the app; run start manually each time');
  print.hint('This version only manages processes; MCP tools are not yet exposed to the model');
  print.blank();
  return 0;
}

function resolve(ref) {
  const server = mcp.findServer(ref);
  if (!server) {
    print.fail(`MCP not found: ${ref}`);
    return null;
  }
  return server;
}

async function add(opts) {
  let name = opts.name;
  let command = opts.command;
  if (!name && process.stdin.isTTY) name = String((await ask('Name: ')) || '').trim();
  if (!command && process.stdin.isTTY) command = String((await ask('Start command (e.g. npx): ')) || '').trim();
  if (!name || !command) {
    throw Object.assign(new Error('Usage: dgxay mcp add --name <name> --command <command> [--args "..."]'), {
      userError: true
    });
  }
  const server = mcp.addServer({
    name,
    command,
    args: opts.args || '',
    env: (opts.env || []).join('\n'),
    cwd: opts.cwd || ''
  });
  print.ok(`Saved MCP server "${server.name}" (${server.id})`);
  print.hint(`Start: dgxay mcp start ${server.name}`);
  return 0;
}

function start(ref) {
  const server = resolve(ref);
  if (!server) return 1;
  try {
    const result = mcp.startServer(server.id);
    if (result.status === 'running' && result.pid) print.ok(`Started ${server.name} (pid ${result.pid})`);
    else print.ok(`${server.name} is already running`);
    print.hint(`View logs: dgxay mcp logs ${server.name}`);
    return 0;
  } catch (err) {
    print.fail(err.message);
    return 1;
  }
}

function stop(ref) {
  const server = resolve(ref);
  if (!server) return 1;
  const ok = mcp.stopServer(server.id);
  if (ok) print.ok(`Stopped ${server.name}`);
  else print.warn(`${server.name} is not running`);
  return 0;
}

async function logs(ref, opts) {
  const server = resolve(ref);
  if (!server) return 1;
  const shown = new Set();
  const printLogs = () => {
    const entries = mcp.statusOf(server.id).logs || [];
    for (const entry of entries) {
      const key = `${entry.at}:${entry.stream}:${entry.text}`;
      if (shown.has(key)) continue;
      shown.add(key);
      print.write(entry.stream === 'stderr' ? COLORS.red(entry.text) : entry.text);
    }
  };
  printLogs();
  if (!opts.follow) {
    if (!shown.size) print.hint('No logs yet');
    return 0;
  }
  print.hint('Streaming; press Ctrl+C to exit');
  mcp.setNotifier((event) => {
    if (event.type === 'log' && event.id === server.id) {
      print.write(event.stream === 'stderr' ? COLORS.red(event.text) : event.text);
    }
  });
  await new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
  });
  return 0;
}

async function remove(ref, opts) {
  const server = resolve(ref);
  if (!server) return 1;
  if (!opts.yes && process.stdin.isTTY) {
    const answer = await ask(`Delete MCP server "${server.name}" and stop its process? [y/N] `);
    if (!/^y/i.test(String(answer || '').trim())) {
      print.hint('Cancelled');
      return 1;
    }
  }
  mcp.removeServer(server.id);
  print.ok(`Deleted ${server.name}`);
  return 0;
}

function updateEnv(ref, opts) {
  const server = resolve(ref);
  if (!server) return 1;
  const env = { ...(server.env || {}) };
  for (const pair of opts.env || []) {
    const index = String(pair).indexOf('=');
    if (index > 0) env[String(pair).slice(0, index).trim()] = String(pair).slice(index + 1).trim();
  }
  mcp.addServer({
    name: server.name,
    command: server.command,
    args: server.args,
    env,
    cwd: server.cwd
  });
  print.ok(`Updated environment variables for ${server.name} (${Object.keys(env).length} entries)`);
  print.warn('Takes effect after restart: dgxay mcp stop ' + server.name + ' && dgxay mcp start ' + server.name);
  return 0;
}

async function run({ argv }) {
  const { action: rawAction, rest: restArgs, options: opts } = actionFirst(argv, options);
  const action = rawAction || 'list';
  const ref = restArgs.join(' ');

  // 兼容：dgxay mcp <名称> 视为 start
  if (!['list', 'ls', 'add', 'start', 'run', 'stop', 'logs', 'log', 'rm', 'remove', 'delete', 'env'].includes(action)) {
    return start(restArgs.join(' '));
  }

  switch (action) {
    case 'list':
    case 'ls':
      return list();
    case 'add':
      return add(opts);
    case 'start':
    case 'run':
      if (!ref) throw Object.assign(new Error('Usage: dgxay mcp start <name|id>'), { userError: true });
      return start(ref);
    case 'stop':
      if (!ref) throw Object.assign(new Error('Usage: dgxay mcp stop <name|id>'), { userError: true });
      return stop(ref);
    case 'logs':
    case 'log':
      if (!ref) throw Object.assign(new Error('Usage: dgxay mcp logs <name|id> [-f]'), { userError: true });
      return logs(ref, opts);
    case 'rm':
    case 'remove':
    case 'delete':
      if (!ref) throw Object.assign(new Error('Usage: dgxay mcp rm <name|id>'), { userError: true });
      return remove(ref, opts);
    case 'env':
      if (!ref) throw Object.assign(new Error('Usage: dgxay mcp env <name|id> --env "KEY=value"'), { userError: true });
      return updateEnv(ref, opts);
    default:
      return 1;
  }
}

module.exports = {
  name: 'mcp',
  summary: 'Manage MCP servers',
  usage: 'dgxay mcp <list|add|start|stop|logs|rm|env>',
  options,
  subcommands: [
    ['list', 'List MCP servers'],
    ['add', 'Add a server'],
    ['start <name>', 'Start the process'],
    ['stop <name>', 'Stop the process'],
    ['logs <name> [-f]', 'View logs'],
    ['rm <name>', 'Delete'],
    ['env <name> --env K=V', 'Update environment variables']
  ],
  examples: [
    'dgxay mcp add --name filesystem --command npx --args "-y @modelcontextprotocol/server-filesystem ."',
    'dgxay mcp start filesystem',
    'dgxay mcp logs filesystem -f'
  ],
  run
};
