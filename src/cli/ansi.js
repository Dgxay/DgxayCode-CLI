'use strict';

/**
 * 终端渲染：颜色、Markdown → ANSI、状态栏、上下文环。
 *
 * 规则：
 *  - 非 TTY 或设置了 NO_COLOR / TERM=dumb 时自动降级为纯文本；
 *  - DGXAY_COLOR=always 可强制开启颜色（测试与重定向时用）；
 *  - 统一蓝色强调色 #2563EB，与桌面版视觉一致（256 色 27 号 / 真彩 #2563EB）。
 */

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  strike: '\x1b[9m'
};

let colorLevel = detectColor();

function detectColor() {
  const forced = String(process.env.DGXAY_COLOR || '').toLowerCase();
  if (forced === 'always' || forced === '1' || forced === 'true') return 'truecolor';
  if (forced === 'never' || forced === '0' || forced === 'false') return 'none';
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return 'none';
  if (process.env.TERM === 'dumb') return 'none';
  if (!process.stdout.isTTY) return 'none';
  if (/truecolor|24bit/i.test(process.env.COLORTERM || '')) return 'truecolor';
  return 'ansi256';
}

function setColorMode(mode) {
  if (['none', 'ansi256', 'truecolor'].includes(mode)) colorLevel = mode;
  return colorLevel;
}

function colorEnabled() {
  return colorLevel !== 'none';
}

/** 蓝色强调色 */
function accent(text) {
  if (!colorEnabled()) return String(text);
  return colorLevel === 'truecolor' ? `\x1b[38;2;37;99;235m${text}${ANSI.reset}` : `\x1b[38;5;27m${text}${ANSI.reset}`;
}

function paint(code, text) {
  if (!colorEnabled()) return String(text);
  return `${code}${text}${ANSI.reset}`;
}

const rgb = (r, g, b, text) => {
  if (!colorEnabled()) return String(text);
  if (colorLevel === 'truecolor') return `\x1b[38;2;${r};${g};${b}m${text}${ANSI.reset}`;
  return paint(`\x1b[38;5;${to256(r, g, b)}m`, text);
};

function to256(r, g, b) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

const COLORS = {
  dim: (t) => paint('\x1b[38;5;245m', t),
  faint: (t) => paint('\x1b[38;5;242m', t),
  text: (t) => paint('\x1b[38;5;252m', t),
  strong: (t) => paint(`\x1b[1m\x1b[38;5;255m`, t),
  green: (t) => paint('\x1b[38;5;70m', t),
  red: (t) => paint('\x1b[38;5;167m', t),
  yellow: (t) => paint('\x1b[38;5;179m', t),
  cyan: (t) => paint('\x1b[38;5;73m', t),
  magenta: (t) => paint('\x1b[38;5;140m', t),
  accent,
  bold: (t) => paint(ANSI.bold, t),
  underline: (t) => paint(ANSI.underline, t)
};

/* ------------------------------ 终端能力 ------------------------------ */

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function termWidth() {
  const width = Number(process.stdout.columns) || 0;
  if (width > 0) return Math.max(20, width);
  return 80;
}

function useUnicode() {
  if (process.env.DGXAY_ASCII === '1') return false;
  if (process.platform === 'win32') {
    const cp = process.stdout.isTTY ? 65001 : 0;
    return cp === 65001 || Number(process.stdout.columns) > 0;
  }
  return true;
}

function clearLine() {
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
}

function hideCursor() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25l');
}

function showCursor() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
}

/* ------------------------------ 文本测量 ------------------------------ */

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

/** 显示宽度：CJK / 全角算 2，组合字符算 0 */
function charWidth(codePoint) {
  if (codePoint === 0x200b || codePoint === 0xfeff) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text) {
  let width = 0;
  for (const char of stripAnsi(text)) width += charWidth(char.codePointAt(0));
  return width;
}

/** 按显示宽度截断，超出补省略号 */
function truncate(text, max) {
  const raw = String(text ?? '');
  if (max <= 0) return '';
  if (displayWidth(raw) <= max) return raw;
  const ellipsis = max >= 2 ? (useUnicode() ? '…' : '.') : '';
  const budget = max - displayWidth(ellipsis);
  let out = '';
  let width = 0;
  for (const char of raw) {
    const w = charWidth(char.codePointAt(0));
    if (width + w > budget) break;
    out += char;
    width += w;
  }
  return out + ellipsis;
}

/** 按显示宽度右对齐补空格 */
function padEnd(text, width) {
  const diff = width - displayWidth(text);
  return diff > 0 ? `${text}${' '.repeat(diff)}` : String(text);
}

function wrapText(text, width) {
  const lines = [];
  let current = '';
  let currentWidth = 0;
  for (const char of String(text ?? '')) {
    if (char === '\n') {
      lines.push(current);
      current = '';
      currentWidth = 0;
      continue;
    }
    const w = charWidth(char.codePointAt(0));
    if (current && currentWidth + w > width) {
      lines.push(current);
      current = '';
      currentWidth = 0;
    }
    current += char;
    currentWidth += w;
  }
  if (current) lines.push(current);
  return lines;
}

/* ------------------------------ Markdown → ANSI ------------------------------ */

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 中西文混排留白：中文旁边紧跟英文/数字时补一个空格，读起来更松弛。
 * 只在渲染层做，不改原文；已有空格的地方不重复补。
 */
const CJK = '\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff';
const LATIN = 'A-Za-z0-9@#$%&_+=/\\\\';
function spacing(text) {
  let out = String(text ?? '');
  out = out.replace(new RegExp(`([${CJK}])([${LATIN}])`, 'g'), '$1 $2');
  out = out.replace(new RegExp(`([${LATIN}])([${CJK}])`, 'g'), '$1 $2');
  return out;
}

function renderInline(source) {
  const tokens = [];
  const hold = (text) => {
    tokens.push(text);
    return `\u0000${tokens.length - 1}\u0000`;
  };

  // 中西文留白在“标记解析前”做，只处理纯文本部分（占位符不会被误伤）
  let text = spacing(String(source ?? ''));

  // 行内代码优先，内部不再解析其他标记
  text = text.replace(/`+([^`\n]+?)`+/g, (m, code) => hold(COLORS.cyan(code)));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => hold(`🖼 ${alt || url}`));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) =>
    hold(`${label}${COLORS.faint(` (${url})`)}`)
  );
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, (m, url) => hold(url));
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (m, inner) => hold(COLORS.bold(inner)));
  text = text.replace(/__([^_\n]+)__/g, (m, inner) => hold(COLORS.bold(inner)));
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, (m, pre, inner) => `${pre}${hold(COLORS.italic(inner))}`);
  text = text.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, (m, pre, inner) => `${pre}${hold(COLORS.italic(inner))}`);
  text = text.replace(/~~([^~\n]+)~~/g, (m, inner) => hold(paint(ANSI.strike, inner)));

  // 占位符替换：重复执行直到没有占位符（替换结果本身可能含占位符形态）
  let guard = 0;
  while (guard < 6) {
    let replaced = false;
    text = text.replace(/\u0000(\d+)\u0000/g, (m, index) => {
      const value = tokens[Number(index)];
      if (value === undefined) return '';
      replaced = true;
      return value;
    });
    if (!replaced) break;
    guard += 1;
  }
  return text.replace(/\u0000\d+\u0000/g, '');
}

/** 把 Markdown 渲染成适合终端的多行 ANSI 文本（保留块内空行，末尾只补一个换行） */
function renderMarkdown(source, options = {}) {
  const body = renderMarkdownBody(source, options);
  return body ? `${body}\n` : '';
}

/** 渲染但不强制补齐结尾换行；表格需要“往前看一行”的能力，因此返回已渲染的行数组 */
function renderMarkdownBody(source, options = {}) {
  const width = Math.max(24, (options.width || termWidth()) - 2);
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let index = 0;
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  const unicode = useUnicode();

  const flushCode = () => {
    const gutter = unicode ? '│ ' : '| ';
    if (codeLang) out.push(COLORS.faint(`  ${codeLang}`));
    for (const line of codeLines) out.push(`${COLORS.faint(gutter)}${COLORS.green(line)}`);
    if (!codeLines.length) out.push(COLORS.faint(gutter));
    codeLines = [];
    codeLang = '';
  };

  while (index < lines.length) {
    const line = lines[index];

    if (/^\s*(```|~~~)/.test(line)) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
        codeLang = line.replace(/^\s*(```|~~~)\s*/, '').trim();
      }
      index += 1;
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      index += 1;
      continue;
    }

    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      index += 1;
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = renderInline(heading[2].replace(/\s+#+\s*$/, ''));
      if (level === 1) out.push('', COLORS.bold(text), COLORS.accent(unicode ? '━'.repeat(Math.min(width, 40)) : '='.repeat(Math.min(width, 40))));
      else if (level === 2) out.push(COLORS.bold(text), COLORS.faint(unicode ? '─'.repeat(Math.min(width, 32)) : '-'.repeat(Math.min(width, 32))));
      else out.push(COLORS.bold(`${level >= 4 ? '›' : '▸'} ${text}`));
      index += 1;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(COLORS.faint((unicode ? '─' : '-').repeat(Math.min(width, 40))));
      index += 1;
      continue;
    }

    // 引用（可嵌套）
    const quote = line.match(/^(\s*(?:>\s*)+)(.*)$/);
    if (quote) {
      const depth = (quote[1].match(/>/g) || []).length;
      const prefix = `${'  '.repeat(Math.max(0, depth - 1))}${COLORS.accent(unicode ? '▎' : '|')} `;
      for (const piece of wrapText(quote[2], width - depth * 2 - 2)) {
        out.push(`${prefix}${COLORS.dim(renderInline(piece))}`);
      }
      index += 1;
      continue;
    }

    // 表格（表头行 + 分隔行）；必须是当前行是分隔行、上一行是表头
    const isSeparatorRow = (text) =>
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(text) && text.includes('-');
    if (index > 0 && isSeparatorRow(line) && lines[index - 1].includes('|') && out.length) {
      // 表头在上一轮已经作为段落输出，把它取回来重新排版
      out.pop();
      const splitRow = (row) =>
        row
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((cell) => cell.trim());
      const header = splitRow(lines[index - 1]);
      const align = splitRow(line).map((cell) => {
        if (/^:-+:$/.test(cell)) return 'center';
        if (/-+:$/.test(cell)) return 'right';
        return 'left';
      });
      index += 1;
      const rows = [];
      while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      const columns = Math.max(header.length, ...rows.map((row) => row.length));
      const widths = [];
      for (let col = 0; col < columns; col += 1) {
        const cells = [header[col] || '', ...rows.map((row) => row[col] || '')];
        widths[col] = Math.min(40, Math.max(...cells.map((cell) => displayWidth(cell))));
      }
      const renderRow = (cells, bold) =>
        cells
          .map((cell, col) => {
            const clipped = truncate(cell, widths[col]);
            const gap = Math.max(0, widths[col] - displayWidth(clipped));
            const mode = align[col] || 'left';
            const body =
              mode === 'right'
                ? `${' '.repeat(gap)}${clipped}`
                : mode === 'center'
                  ? `${' '.repeat(Math.floor(gap / 2))}${clipped}${' '.repeat(Math.ceil(gap / 2))}`
                  : `${clipped}${' '.repeat(gap)}`;
            return bold ? COLORS.bold(body) : body;
          })
          .join(COLORS.faint(' │ '));
      out.push(`${COLORS.faint('│ ')}${renderRow(header, true)}${COLORS.faint(' │')}`);
      out.push(COLORS.faint(`  ${widths.map((w) => '─'.repeat(w)).join('─┼─')}`));
      for (const row of rows) {
        const padded = [];
        for (let col = 0; col < columns; col += 1) padded.push(row[col] || '');
        out.push(`${COLORS.faint('│ ')}${renderRow(padded, false)}${COLORS.faint(' │')}`);
      }
      continue;
    }

    // 列表（支持缩进与复选框）
    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (list) {
      const indent = Math.floor(list[1].replace(/\t/g, '  ').length / 2);
      const marker = /^\d/.test(list[2]) ? list[2] : unicode ? '•' : '-';
      let content = list[3];
      let checkbox = '';
      const task = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        checkbox = task[1].trim() ? COLORS.green('[✓] ') : COLORS.dim('[ ] ');
        content = task[2];
      }
      const prefix = `${'  '.repeat(indent)}${COLORS.accent(marker)} ${checkbox}`;
      const hang = displayWidth(prefix);
      const pieces = wrapText(content, Math.max(12, width - hang));
      pieces.forEach((piece, i) => {
        out.push(`${i === 0 ? prefix : ' '.repeat(hang)}${renderInline(piece)}`);
      });
      index += 1;
      continue;
    }

    // 普通段落：软换行合并（遇到任何块级结构就停下，表格分隔行走专用分支）
    let paragraph = line;
    let lookahead = index + 1;
    const stopsParagraph = (text) =>
      /^\s*(```|~~~|#{1,6}\s|>)/.test(text) ||
      /^\s*([-*+]|\d+[.)])\s/.test(text) ||
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(text) ||
      isSeparatorRow(text);
    while (lookahead < lines.length && lines[lookahead].trim() && !stopsParagraph(lines[lookahead])) {
      paragraph += ` ${lines[lookahead].trim()}`;
      lookahead += 1;
    }
    for (const piece of wrapText(paragraph, width)) if (piece) out.push(renderInline(piece));
    index = lookahead;
  }

  if (inCode) flushCode();

  while (out.length && out[0] === '') out.shift();
  // 注意：结尾的空行由调用方决定（流式输出逐行渲染时需要保留块内空行）
  return out.join('\n');
}

/* ------------------------------ 组件 ------------------------------ */

function ring(ratio) {
  if (!colorEnabled()) {
    return `${Math.round(Math.min(1, ratio) * 100)}%`;
  }
  const segments = 8;
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * segments);
  return COLORS.accent('●'.repeat(filled)) + COLORS.faint('○'.repeat(segments - filled));
}

function badge(text, kind = 'accent') {
  const palette = {
    accent,
    green: COLORS.green,
    red: COLORS.red,
    yellow: COLORS.yellow,
    dim: COLORS.dim
  };
  return (palette[kind] || accent)(`[${text}]`);
}

/** 状态符号（自动降级为 ASCII） */
const SIGN = useUnicode()
  ? { ok: '✓', fail: '✗', run: '⠿', dot: '·', arrow: '›', bullet: '•', ellipse: '…', check: '✓' }
  : { ok: 'ok', fail: 'x', run: '*', dot: '.', arrow: '>', bullet: '-', ellipse: '...', check: 'ok' };

module.exports = {
  COLORS,
  SIGN,
  accent,
  paint,
  rgb,
  colorEnabled,
  setColorMode,
  isInteractive,
  termWidth,
  useUnicode,
  clearLine,
  hideCursor,
  showCursor,
  stripAnsi,
  displayWidth,
  charWidth,
  truncate,
  padEnd,
  wrapText,
  renderMarkdown,
  renderInline,
  spacing,
  escapeHtml,
  ring
};
