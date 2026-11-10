'use strict';

/**
 * 会话状态桥：让另一个终端里的子命令可以看到并使用当前交互会话的
 * 工作空间、模型、权限、会话 id。
 *
 * 状态文件：~/.dcb/repl-state.json（0600，原子写入，每 5 秒刷新心跳）。
 * 这样即使两个进程同时运行，也只会各自读一份最新状态，不互相覆盖配置。
 */

const fs = require('fs');
const path = require('path');
const { DCB_DIR } = require('./config');

const STATE_PATH = path.join(DCB_DIR, 'repl-state.json');
const HEARTBEAT_MS = 5000;
const STALE_MS = 60000;

function read() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function write(state) {
  try {
    fs.mkdirSync(DCB_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${STATE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    fs.renameSync(tmp, STATE_PATH);
    return true;
  } catch {
    return false;
  }
}

function clear(state = null) {
  const current = state || read();
  if (current && current.pid && current.pid !== process.pid) return false;
  try {
    if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** 读取仍然「活着」的会话状态 */
function live() {
  const state = read();
  if (!state) return null;
  if (!pidAlive(state.pid)) return null;
  if (state.updatedAt && Date.now() - Number(state.updatedAt) > STALE_MS) return null;
  return state;
}

/** 由 REPL 持有：周期性刷新心跳 */
class Heartbeat {
  constructor(getState) {
    this.getState = getState;
    this.timer = null;
  }

  start() {
    this.stop();
    const beat = () => {
      try {
        const state = this.getState();
        if (state) write({ ...state, pid: process.pid });
      } catch {
        /* ignore */
      }
    };
    beat();
    this.timer = setInterval(beat, HEARTBEAT_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = { STATE_PATH, read, write, clear, live, Heartbeat, pidAlive, STALE_MS };
