'use strict';

/**
 * 可复用的小工具：提示输入、确认、掩码输入、状态行。
 */

const readline = require('readline');
const { COLORS } = require('../cli/ansi');

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(String(answer || ''));
    });
    rl.on('SIGINT', () => {
      rl.close();
      resolve(null);
    });
  });
}

/** 掩码输入（用于 API Key；非 TTY 时退化为普通读取） */
function askSecret(prompt, options = {}) {
  if (!process.stdin.isTTY) return ask(prompt);
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    let value = '';
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        stdin.setRawMode(false);
        stdin.removeListener('keypress', onKey);
        process.stdout.write('\n');
        resolve(null);
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        stdin.setRawMode(false);
        stdin.removeListener('keypress', onKey);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (key.name === 'backspace') {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      if (key.ctrl && key.name === 'u') {
        process.stdout.write('\b \b'.repeat(value.length));
        value = '';
        return;
      }
      if (str && !key.ctrl && !key.meta) {
        value += str;
        process.stdout.write(options.showLength ? String(str.length) : '*');
      }
    };
    stdin.on('keypress', onKey);
  });
}

async function confirm(prompt, defaultYes = false) {
  if (!process.stdin.isTTY) return false;
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = await ask(`${prompt}${suffix}`);
  if (answer === null) return false;
  const text = answer.trim().toLowerCase();
  if (!text) return defaultYes;
  return text === 'y' || text === 'yes' || text === '是';
}

/** 单行状态提示（覆盖当前行，避免刷新时刷屏） */
function statusLine(text) {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\r\x1b[2K${COLORS.faint(text)}`);
}

function clearStatus() {
  if (!process.stdout.isTTY) return;
  process.stdout.write('\r\x1b[2K');
}

module.exports = { ask, askSecret, confirm, statusLine, clearStatus };
