'use strict';

/**
 * 输出辅助：统一成功 / 提示 / 错误 / 表格 / 键值列表的样式。
 */

const { COLORS, SIGN, displayWidth, truncate, termWidth, renderMarkdown } = require('./ansi');

function write(text = '') {
  process.stdout.write(`${text}\n`);
}

function print(text = '') {
  write(text);
}

function blank() {
  write('');
}

function ok(message) {
  write(`${COLORS.green(SIGN.ok)} ${message}`);
}

function info(message) {
  write(`${COLORS.accent(SIGN.bullet)} ${message}`);
}

function warn(message) {
  write(`${COLORS.yellow('!')} ${message}`);
}

function fail(message) {
  process.stderr.write(`${COLORS.red(SIGN.fail)} ${message}\n`);
}

function hint(message) {
  write(COLORS.faint(message));
}

function heading(text) {
  write(`${COLORS.bold(text)}`);
}

function markdown(text, width = termWidth()) {
  process.stdout.write(renderMarkdown(text, { width }));
}

/** 按显示宽度补空格（中文占两格，padEnd 会算错） */
function padWidth(text, width) {
  const visible = displayWidth(text);
  return visible >= width ? String(text) : `${text}${' '.repeat(width - visible)}`;
}

/** 键值列表：条目 { label, value, tone } */
function keyValue(rows, options = {}) {
  const indent = options.indent || '  ';
  const width = Math.max(...rows.map((row) => displayWidth(String(row.label))));
  for (const row of rows) {
    const label = `${indent}${COLORS.faint(padWidth(String(row.label), width))}`;
    const value = row.tone ? COLORS[row.tone](String(row.value ?? '')) : String(row.value ?? '');
    if (row.multiline) {
      write(label);
      for (const line of String(row.value ?? '').split('\n')) write(`${indent}${' '.repeat(width + 2)}${line}`);
    } else {
      write(`${label}  ${value}`);
    }
  }
}

/** 表格：columns 决定列宽；rows 为二维数组 */
function table(columns, rows) {
  const widths = columns.map((col, index) => {
    const head = displayWidth(col.title);
    const cells = rows.map((row) => displayWidth(String(row[index] ?? '')));
    const max = Math.min(col.max || 60, Math.max(head, ...cells));
    return Math.max(head, Math.min(max, Math.max(head, ...cells)));
  });
  const total = widths.reduce((sum, w) => sum + w, 0) + (columns.length - 1) * 2;
  const limit = termWidth() - 1;
  if (total > limit) {
    const overflow = total - limit;
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] = Math.max(6, widths[widest] - overflow);
  }
  const line = (cells, painter) =>
    cells
      .map((cell, index) => {
        const text = truncate(String(cell ?? '').replace(/\n/g, ' '), widths[index]);
        const pad = ' '.repeat(Math.max(0, widths[index] - displayWidth(text)));
        return painter ? painter(`${text}${pad}`) : `${text}${pad}`;
      })
      .join('  ')
      .replace(/\s+$/, '');
  write(line(columns.map((col) => col.title), COLORS.faint));
  write(COLORS.faint(widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const row of rows) write(line(row));
}

/** 简单的使用说明 */
function usage(command) {
  if (!command) return;
  write(`${COLORS.bold(`dgxay ${command.name}`)}${command.summary ? COLORS.faint(` — ${command.summary}`) : ''}`);
  if (command.usage) {
    blank();
    write(COLORS.faint('Usage'));
    write(`  ${command.usage}`);
  }
  if (command.examples?.length) {
    blank();
    write(COLORS.faint('Examples'));
    for (const example of command.examples) write(`  ${COLORS.cyan(example)}`);
  }
  if (command.options?.length) {
    blank();
    write(COLORS.faint('Options'));
    const rows = command.options.map((opt) => {
      const alias = opt.alias ? [].concat(opt.alias).map((a) => (a.length === 1 ? `-${a}` : a)).join(', ') : '';
      const name = `--${opt.name}${opt.type && opt.type !== 'boolean' ? ` <${opt.valueName || opt.type}>` : ''}`;
      return [alias ? `${alias}, ${name}` : name, opt.desc || ''];
    });
    rows.push(['-h, --help', 'Show help']);
    const width = Math.max(...rows.map(([flag]) => displayWidth(flag)));
    for (const [flag, desc] of rows) write(`  ${COLORS.cyan(padWidth(flag, width))}  ${COLORS.faint(desc)}`);
  }
  if (command.subcommands?.length) {
    blank();
    write(COLORS.faint('Commands'));
    const width = Math.max(...command.subcommands.map(([, name]) => displayWidth(name)));
    for (const [name, desc] of command.subcommands) write(`  ${COLORS.accent(padWidth(name, width))}  ${desc}`);
  }
}

module.exports = {
  write,
  print,
  blank,
  ok,
  info,
  warn,
  fail,
  hint,
  heading,
  keyValue,
  table,
  usage,
  markdown
};
