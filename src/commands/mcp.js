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
  { name: 'name', type: 'string', valueName: 'text', desc: '显示名称' },
  { name: 'command', type: 'string', valueName: 'cmd', desc: '启动命令（如 npx / uvx）' },
  { name: 'args', type: 'string', valueName: 'text', desc: '命令参数' },
  { name: 'env', type: 'list', valueName: 'K=V', desc: '环境变量，可重复' },
  { name: 'cwd', type: 'string', valueName: 'dir', desc: '工作目录' },
  { name: 'follow', alias: 'f', type: 'boolean', desc: 'logs：持续输出' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: '跳过确认' }
];

function statusText(status) {
  if (status === 'running') return COLORS.green('运行中');
  if (status === 'error') return COLORS.red('异常');
  if (status === 'stopping') return COLORS.yellow('停止中');
  return COLORS.faint('已停止');
}

function list() {
  const servers = mcp.listServers();
  print.blank();
  if (!servers.length) {
    print.hint(`还没有 MCP Server（配置保存在 ${cfg.MCP_PATH}）`);
    print.hint('添加：dgxay mcp add --name filesystem --command npx --args "-y @modelcontextprotocol/server-filesystem ."');
    print.blank();
    return 0;
  }
  print.heading(`MCP Server（${servers.length}）`);
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
      { title: '名称', max: 20 },
      { title: '状态', max: 8 },
      { title: 'PID', max: 7 },
      { title: '命令', max: 50 },
      { title: '工作目录', max: 30 }
    ],
    rows
  );
  print.blank();
  print.hint('MCP 不会随应用启动而自动运行；每次启动后需要手动 start');
  print.hint('当前版本只管理进程，尚未把 MCP 工具接入模型');
  print.blank();
  return 0;
}

function resolve(ref) {
  const server = mcp.findServer(ref);
  if (!server) {
    print.fail(`找不到 MCP：${ref}`);
    return null;
  }
  return server;
}

async function add(opts) {
  let name = opts.name;
  let command = opts.command;
  if (!name && process.stdin.isTTY) name = String((await ask('名称: ')) || '').trim();
  if (!command && process.stdin.isTTY) command = String((await ask('启动命令（如 npx）: ')) || '').trim();
  if (!name || !command) {
    throw Object.assign(new Error('用法：dgxay mcp add --name <名称> --command <命令> [--args "..."]'), {
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
  print.ok(`已保存 MCP「${server.name}」（${server.id}）`);
  print.hint(`启动：dgxay mcp start ${server.name}`);
  return 0;
}

function start(ref) {
  const server = resolve(ref);
  if (!server) return 1;
  try {
    const result = mcp.startServer(server.id);
    if (result.status === 'running' && result.pid) print.ok(`已启动 ${server.name}（pid ${result.pid}）`);
    else print.ok(`${server.name} 已在运行`);
    print.hint(`查看日志：dgxay mcp logs ${server.name}`);
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
  if (ok) print.ok(`已停止 ${server.name}`);
  else print.warn(`${server.name} 当前没有运行`);
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
    if (!shown.size) print.hint('暂无日志');
    return 0;
  }
  print.hint('持续输出中，Ctrl+C 退出');
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
    const answer = await ask(`删除 MCP「${server.name}」并停止进程？[y/N] `);
    if (!/^y/i.test(String(answer || '').trim())) {
      print.hint('已取消');
      return 1;
    }
  }
  mcp.removeServer(server.id);
  print.ok(`已删除 ${server.name}`);
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
  print.ok(`已更新 ${server.name} 的环境变量（${Object.keys(env).length} 项）`);
  print.warn('重启后生效：dgxay mcp stop ' + server.name + ' && dgxay mcp start ' + server.name);
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
      if (!ref) throw Object.assign(new Error('用法：dgxay mcp start <名称|ID>'), { userError: true });
      return start(ref);
    case 'stop':
      if (!ref) throw Object.assign(new Error('用法：dgxay mcp stop <名称|ID>'), { userError: true });
      return stop(ref);
    case 'logs':
    case 'log':
      if (!ref) throw Object.assign(new Error('用法：dgxay mcp logs <名称|ID> [-f]'), { userError: true });
      return logs(ref, opts);
    case 'rm':
    case 'remove':
    case 'delete':
      if (!ref) throw Object.assign(new Error('用法：dgxay mcp rm <名称|ID>'), { userError: true });
      return remove(ref, opts);
    case 'env':
      if (!ref) throw Object.assign(new Error('用法：dgxay mcp env <名称|ID> --env "KEY=value"'), { userError: true });
      return updateEnv(ref, opts);
    default:
      return 1;
  }
}

module.exports = {
  name: 'mcp',
  summary: 'MCP Server 管理',
  usage: 'dgxay mcp <list|add|start|stop|logs|rm|env>',
  options,
  subcommands: [
    ['list', '列出 MCP Server'],
    ['add', '新增配置'],
    ['start <名称>', '启动进程'],
    ['stop <名称>', '停止进程'],
    ['logs <名称> [-f]', '查看日志'],
    ['rm <名称>', '删除'],
    ['env <名称> --env K=V', '更新环境变量']
  ],
  examples: [
    'dgxay mcp add --name filesystem --command npx --args "-y @modelcontextprotocol/server-filesystem ."',
    'dgxay mcp start filesystem',
    'dgxay mcp logs filesystem -f'
  ],
  run
};
