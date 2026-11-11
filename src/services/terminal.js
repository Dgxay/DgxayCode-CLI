'use strict';

/**
 * 终端命令执行（对应桌面版的 `!` 命令）。
 *
 * 与工具 run_command 的区别：这是用户自己发起的命令，输出会展示并进入对话上下文。
 * 权限与工具一致：none 拒绝；normal 每次询问；auto 先审查；full 直接执行。
 * 同一时间只允许一个命令；超过 5 分钟自动终止；累计输出超过 300000 字符截断。
 */

const { spawn, execFile } = require('child_process');
const os = require('os');
const fs = require('fs');

const MAX_TOTAL = 300000;
const TIMEOUT_MS = 300000;

function killProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 2000).unref?.();
}

function resolveCwd(workspace) {
  const target = workspace || os.homedir();
  try {
    return fs.statSync(target).isDirectory() ? target : os.homedir();
  } catch {
    return os.homedir();
  }
}

/**
 * 运行命令。
 * @param {object} options
 * @param {string} options.command
 * @param {string} [options.workspace]
 * @param {(chunk: string, stream: 'stdout'|'stderr') => void} [options.onOutput]
 * @returns {Promise<{ ok:boolean, code:number|null, signal:string|null, output:string, stderr:string, aborted:boolean, error?:string }>}
 */
function runShellCommand({ command, workspace, onOutput }) {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shellCommand = isWindows ? `chcp 65001>nul & ${command}` : command;
    const cwd = resolveCwd(workspace);
    let child;
    try {
      child = spawn(shellCommand, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ ok: false, code: null, signal: null, output: '', stderr: '', aborted: false, error: err.message });
      return;
    }

    let output = '';
    let stderr = '';
    let total = 0;
    let truncated = false;
    let finished = false;

    const push = (stream, chunk) => {
      const text = chunk.toString('utf8').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
      total += text.length;
      if (total > MAX_TOTAL) {
        if (!truncated) {
          truncated = true;
          const note = '\n… (output too long, truncated)\n';
          stderr += note;
          onOutput?.(note, 'stderr');
        }
        return;
      }
      if (stream === 'stderr') stderr += text;
      else output += text;
      onOutput?.(text, stream);
    };

    child.stdout?.on('data', (chunk) => push('stdout', chunk));
    child.stderr?.on('data', (chunk) => push('stderr', chunk));

    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: true, code, signal, output, stderr, aborted: signal === 'SIGTERM' || signal === 'SIGKILL' });
    };

    child.on('error', (err) => {
      onOutput?.(`\n[failed to start] ${err.message}\n`, 'stderr');
      finish(-1, null);
    });
    child.on('exit', (code, signal) => finish(code, signal));

    const timer = setTimeout(() => {
      onOutput?.('\n… (command ran longer than 5 minutes, terminated)\n', 'stderr');
      killProcessTree(child);
    }, TIMEOUT_MS);
    child.on('exit', () => clearTimeout(timer));
    if (child.unref) {
      /* 保持引用，等待退出 */
    }
  });
}

module.exports = { runShellCommand, killProcessTree, MAX_TOTAL, TIMEOUT_MS };
