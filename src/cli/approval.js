'use strict';

/**
 * 授权确认组件（对应桌面版 permission:request 弹窗）。
 *
 * - 普通权限：每次操作都必须确认；
 * - 自动审查：模型放行则直接执行，可疑操作转到这里；
 * - 非交互模式（管道输入）下默认拒绝，避免无人值守时被 AI 静默执行；
 * - 按 Esc 或回答 n 视为拒绝；等待超时 180 秒同样按拒绝处理。
 */

const readline = require('readline');
const { COLORS, displayWidth, truncate, termWidth, wrapText } = require('./ansi');

const APPROVAL_TIMEOUT = 180000;

function frameText(lines, options = {}) {
  const width = Math.min(options.width || 70, Math.max(24, termWidth() - 2));
  const title = options.title || '';
  const accentText = (text) => COLORS.accent(text);
  const body = [];
  if (title) {
    const head = ` ${title} `;
    const fill = Math.max(0, width - displayWidth(head) - 2);
    body.push(`${accentText('┌')}${COLORS.bold(head)}${COLORS.accent(`${'─'.repeat(fill)}┐`)}`);
  } else {
    body.push(COLORS.accent(`┌${'─'.repeat(width)}┐`));
  }
  for (const line of lines) {
    const text = typeof line === 'string' ? line : line.text;
    const raw = typeof line === 'string' ? text : line.raw || text;
    const visible = displayWidth(raw);
    const pad = Math.max(0, width - visible - 2);
    body.push(`${COLORS.accent('│')} ${text}${' '.repeat(pad)} ${COLORS.accent('│')}`);
  }
  body.push(COLORS.accent(`└${'─'.repeat(width)}┘`));
  return body.join('\n');
}

function question(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on('SIGINT', () => {
      rl.close();
      resolve('');
    });
  });
}

/** 单键读取（y / n / Esc / Enter），非 TTY 时回退到整行输入 */
function readKey({ timeout = APPROVAL_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      question('').then((answer) => {
        const text = String(answer || '').trim().toLowerCase();
        resolve({ key: text, line: text });
      });
      return;
    }
    let done = false;
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
    }
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      resolve(result);
    };
    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        finish({ key: 'escape', line: '' });
        return;
      }
      if (key.name === 'escape') {
        finish({ key: 'escape', line: '' });
        return;
      }
      if (key.name === 'return' || key.name === 'enter' || str === '\r' || str === '\n') {
        finish({ key: 'submit', line: '' });
        return;
      }
      if (!key.ctrl && !key.meta && str) {
        const text = String(str).toLowerCase();
        if (text === 'y' || text === 'n') {
          finish({ key: text, line: text });
          return;
        }
        if (text === 'q') {
          finish({ key: 'escape', line: '' });
          return;
        }
        // 其他字符先忽略，避免误触
        process.stdout.write('\x07');
      }
    };
    const timer = setTimeout(() => finish({ key: 'timeout', line: '' }), timeout);
    process.stdin.on('keypress', onKey);
    process.stdin.resume();
  });
}

/**
 * 请求用户授权一次操作。
 * @returns {Promise<boolean>}
 */
async function askApproval(request, options = {}) {
  const interactive = Boolean(process.stdin.isTTY);
  if (!interactive) {
    // 非交互：一律拒绝，并提示如何绕过
    process.stderr.write(
      `${COLORS.yellow('[permission]')} ${request.title}：${request.operation}\n` +
        `${COLORS.dim('  Not an interactive terminal — denied. Use --permission full or run interactively.')}\n`
    );
    return false;
  }

  const lines = [];
  lines.push({ text: `${COLORS.faint('op')}  ${COLORS.bold(request.operation)}`, raw: `op  ${request.operation}` });
  for (const line of String(request.detail || '').split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf('：');
    if (idx > 0) {
      const label = line.slice(0, idx);
      const value = line.slice(idx + 1);
      for (const piece of wrapText(value, 56)) {
        lines.push({
          text: `${COLORS.faint(truncate(label, 6))}  ${piece}`,
          raw: `${label}  ${piece}`
        });
      }
    } else {
      for (const piece of wrapText(line, 60)) lines.push({ text: piece, raw: piece });
    }
  }
  if (request.workspace) {
    lines.push({ text: '', raw: '' });
    lines.push({ text: COLORS.faint(`workspace ${request.workspace}`), raw: `workspace ${request.workspace}` });
  }
  if (request.review) {
    lines.push({ text: '', raw: '' });
    const who = request.reviewer ? `reviewer ${request.reviewer}` : 'auto-review';
    lines.push({ text: COLORS.red(`${who} flagged this`), raw: `${who} flagged this` });
    for (const piece of wrapText(request.review, 58)) {
      lines.push({ text: COLORS.dim(`  ${piece}`), raw: `  ${piece}` });
    }
  }

  process.stdout.write(`${frameText(lines, { title: request.title })}\n`);

  const promptText = `${COLORS.accent('Allow this?')} ${COLORS.faint('[y] yes  [n] no')} `;
  process.stdout.write(promptText);
  const result = await readKey({ timeout: options.timeout || APPROVAL_TIMEOUT });

  if (result.key === 'y') {
    process.stdout.write(`${COLORS.green('allowed')}\n`);
    return true;
  }
  const label =
    result.key === 'timeout'
      ? COLORS.yellow('timed out — denied')
      : result.key === 'escape'
        ? COLORS.dim('denied')
        : COLORS.red('denied');
  process.stdout.write(`${label}\n`);
  return false;
}

module.exports = { askApproval, readKey, question, frameText, APPROVAL_TIMEOUT };
