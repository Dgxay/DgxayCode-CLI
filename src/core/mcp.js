'use strict';

/**
 * MCP 进程管理（与桌面版一致的字段与行为，去掉 Electron 依赖）。
 *
 * 配置保存在 ~/.dcb/mcp.json，字段：name、command、args、env、cwd、enabled。
 * 当前版本只管理进程，不把 MCP 工具暴露给模型（与桌面版保持一致的限制）。
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { DCB_DIR, MCP_PATH } = require('../services/config');

const MAX_LOGS = 400;

/** id -> { child, status, logs, exitCode, startedAt, error } */
const processes = new Map();
let notifier = null;

function setNotifier(fn) {
  notifier = typeof fn === 'function' ? fn : null;
}

function notify(payload) {
  try {
    notifier?.(payload);
  } catch {
    /* ignore */
  }
}

function readConfig() {
  try {
    if (!fs.existsSync(MCP_PATH)) return { servers: [] };
    const parsed = JSON.parse(fs.readFileSync(MCP_PATH, 'utf8'));
    return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
  } catch {
    return { servers: [] };
  }
}

function writeConfig(data) {
  fs.mkdirSync(DCB_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${MCP_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ servers: data.servers || [] }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(tmp, MCP_PATH);
}

function normalizeArgs(raw) {
  if (Array.isArray(raw)) return raw.map((item) => String(item));
  if (typeof raw === 'string' && raw.trim()) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map((item) => String(item));
      } catch {
        /* fall through */
      }
    }
    // 支持带空格与引号的参数：npx -y pkg "D:/my work"
    const tokens = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    return tokens.map((token) => token.replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return [];
}

function normalizeEnv(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    const env = {};
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .forEach((line) => {
        const idx = line.indexOf('=');
        if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
    return env;
  }
  if (typeof raw === 'object') {
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [String(k), String(v)]));
  }
  return {};
}

function addServer(input) {
  const name = String(input?.name || '').trim();
  const command = String(input?.command || '').trim();
  if (!name) throw new Error('MCP 名称不能为空');
  if (!command) throw new Error('MCP 启动命令不能为空');

  const data = readConfig();
  const record = {
    name,
    command,
    args: normalizeArgs(input.args),
    env: normalizeEnv(input.env),
    cwd: String(input.cwd || '').trim(),
    enabled: input.enabled === false ? false : true,
    updatedAt: new Date().toISOString()
  };

  const existing = data.servers.find((server) => server.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    Object.assign(existing, record);
    writeConfig(data);
    return existing;
  }

  const server = {
    id: `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    ...record,
    createdAt: record.updatedAt
  };
  data.servers.push(server);
  writeConfig(data);
  return server;
}

function removeServer(id) {
  stopServer(id);
  const data = readConfig();
  data.servers = data.servers.filter((server) => server.id !== id && server.name !== id);
  writeConfig(data);
  processes.delete(id);
  return true;
}

function statusOf(id) {
  const entry = processes.get(id);
  if (!entry) return { status: 'stopped', logs: [] };
  return {
    status: entry.status,
    pid: entry.child?.pid || null,
    startedAt: entry.startedAt || null,
    exitCode: entry.exitCode ?? null,
    error: entry.error || '',
    logs: entry.logs.slice(-120)
  };
}

function listServers() {
  const data = readConfig();
  return data.servers.map((server) => ({ ...server, ...statusOf(server.id) }));
}

function findServer(idOrName) {
  const key = String(idOrName || '').trim().toLowerCase();
  return listServers().find((server) => server.id === idOrName || String(server.name).toLowerCase() === key) || null;
}

function pushLog(entry, stream, text) {
  const lines = String(text).split(/\r?\n/).filter((line, index, arr) => line || index < arr.length - 1);
  for (const line of lines) {
    entry.logs.push({ stream, text: line, at: Date.now() });
  }
  if (entry.logs.length > MAX_LOGS) entry.logs.splice(0, entry.logs.length - MAX_LOGS);
  notify({ type: 'log', id: entry.id, stream, text: String(text) });
}

function startServer(id) {
  const data = readConfig();
  const server = data.servers.find((item) => item.id === id) || data.servers.find((item) => item.name === id);
  if (!server) throw new Error('找不到该 MCP server');

  const existing = processes.get(server.id);
  if (existing?.status === 'running' && existing.child && !existing.child.killed) {
    return { ok: true, status: 'running', pid: existing.child.pid, server };
  }

  const env = { ...process.env, ...(server.env || {}) };
  let child;
  try {
    child = spawn(server.command, server.args || [], {
      cwd: server.cwd || DCB_DIR,
      env,
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    throw new Error(`无法启动 MCP server：${err.message}`);
  }

  const entry = {
    id: server.id,
    child,
    status: 'running',
    logs: [],
    startedAt: Date.now(),
    exitCode: null,
    error: ''
  };
  processes.set(server.id, entry);
  child.stdout?.on('data', (chunk) => pushLog(entry, 'stdout', chunk.toString('utf8')));
  child.stderr?.on('data', (chunk) => pushLog(entry, 'stderr', chunk.toString('utf8')));
  child.on('error', (err) => {
    entry.status = 'error';
    entry.error = err.message;
    notify({ type: 'status', id: server.id, status: 'error', error: err.message });
  });
  child.on('exit', (code, signal) => {
    const wasStopping = entry.status === 'stopping';
    entry.status = wasStopping || code === 0 ? 'stopped' : 'error';
    entry.exitCode = code;
    if (!wasStopping && code !== 0 && code !== null) {
      entry.error = `进程退出，code=${code}${signal ? `, signal=${signal}` : ''}`;
    }
    notify({ type: 'status', id: server.id, status: entry.status, code, signal });
  });

  notify({ type: 'status', id: server.id, status: 'running', pid: child.pid });
  return { ok: true, status: 'running', pid: child.pid, server };
}

function stopServer(id) {
  const entry = processes.get(id);
  if (!entry?.child) return false;
  const pid = entry.child.pid;
  entry.status = 'stopping';
  notify({ type: 'status', id, status: 'stopping' });

  if (process.platform === 'win32' && pid) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  } else {
    try {
      entry.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (entry.child && !entry.child.killed) entry.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 3000).unref?.();
  }
  return true;
}

function killAll() {
  for (const id of processes.keys()) stopServer(id);
}

function runningServers() {
  return [...processes.entries()]
    .filter(([, entry]) => entry.status === 'running')
    .map(([id]) => id);
}

module.exports = {
  MCP_PATH,
  readConfig,
  addServer,
  removeServer,
  listServers,
  findServer,
  startServer,
  stopServer,
  setNotifier,
  killAll,
  statusOf,
  runningServers
};
