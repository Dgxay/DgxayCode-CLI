'use strict';

/**
 * 行编辑器：带边框的输入框、斜杠补全菜单、历史、多行输入。
 *
 * 终端兼容性（前几次踩坑的教训）：
 *   - 不假设终端支持光标上移 / 清行；
 *   - 启动时探测一次（见 detectCapabilities），支持则做「区域重绘」，不支持则降级；
 *   - 无论如何，输入被提交 / 消息输出后，都不会出现重复行。
 *
 * 交互：
 *   - 输入框是一个方框（┌─┐ │文字│ └─┘），宽度随终端变化；
 *   - 输入 `/` 弹出命令菜单，↑↓ 选择、Tab 补全、Enter 执行；
 *   - 方向键 ↑ 回填上一条用户提示词（不是命令历史，而是对话里说过的话）；
 *   - 行尾 `\` 续行，Enter 提交；Shift+Enter 也可以换行。
 */

const readline = require('readline');
const {
  COLORS,
  displayWidth,
  truncate,
  termWidth,
  useUnicode,
  cursorUp,
  clearLine,
  eraseLine,
  clearScreen
} = require('./ansi');
const { t } = require('./i18n');

/* ------------------------------ 终端能力探测 ------------------------------ */

/**
 * 探测终端是否支持光标上移。
 * 做法：写一行标记 → 上移覆盖 → 下移读回，然后清屏擦掉痕迹。
 * 保守起见：只要不是明确的 Windows conhost，就认为支持（Windows Terminal / VSCode / iTerm 都支持）。
 */
function detectCapabilities(output = process.stdout) {
  if (!output.isTTY) return { cursorUp: false, clearLine: false, interactive: false };
  if (process.env.DGXAY_NO_CURSOR_UP === '1') return { cursorUp: false, clearLine: false, interactive: true };
  const modern =
    Boolean(process.env.WT_SESSION) ||
    Boolean(process.env.TERM_PROGRAM) ||
    process.env.TERM === 'xterm-256color' ||
    process.env.TERM === 'screen-256color' ||
    Boolean(process.env.COLORTERM) ||
    process.platform !== 'win32';
  return { cursorUp: modern, clearLine: true, interactive: true };
}

/* ------------------------------ 编辑��� ------------------------------ */

class LineEditor {
  constructor(options = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.prompt = options.prompt || '';
    this.placeholder = options.placeholder || '';
    this.completer = options.completer || null;
    this.multiline = options.multiline !== false;
    this.maxHistory = options.maxHistory || 500;

    /** 提交过的输入（/命令与普通提问都在这里，用于 ↑） */
    this.history = Array.isArray(options.history) ? options.history.slice() : [];
    this.historyIndex = this.history.length;
    /** 外部注入的「上一条用户提示词」，优先级高于普通历史 */
    this.lastUserPrompt = options.lastUserPrompt || '';

    this.caps = options.capabilities || detectCapabilities(this.output);

    this.value = '';
    this.cursor = 0;
    this.popup = null;
    this.draft = '';
    this.active = false;
    this.finished = false;
    this.resolveQuestion = null;
    this.keyHandler = null;
    this.keyQueue = Promise.resolve();
    this.abortHandler = null;

    /** 已经画在屏幕上的盒子行数（用于区域重绘） */
    this.drawnRows = 0;
    this.frameCursorRow = 0;
    this.frameBoxTop = 0;
    /** 是否已为 input 挂过 keypress 处理器（整个编辑器生命周期只挂一次） */
    this.keypressBound = false;
    this.newlineMark = this.unicode() ? '⏎' : '\\n';
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  setAbortHandler(handler) {
    this.abortHandler = typeof handler === 'function' ? handler : null;
  }

  question(prompt) {
    if (prompt !== undefined) this.prompt = prompt;
    this.value = '';
    this.cursor = 0;
    this.popup = null;
    this.drawnRows = 0;
    this.historyIndex = this.history.length;
    this.active = true;
    this.finished = false;

    return new Promise((resolve) => {
      this.resolveQuestion = resolve;
      // 同一进程里可能多次 question()（权限确认 / 二次提问），keypress 只注册一次，
      // 避免同一按键被多个监听器重复处理
      if (!this.keypressBound) {
        readline.emitKeypressEvents(this.input);
        this.keypressBound = true;
      }
      if (this.input.isTTY) {
        try {
          this.input.setRawMode(true);
        } catch {
          /* ignore */
        }
      }
      this.input.resume();

      this.keyHandler = (str, key) => {
        this.keyQueue = this.keyQueue.then(() => this.handleKey(str || '', key || {})).catch(() => {});
      };
      this.input.on('keypress', this.keyHandler);
      this.draw();
    });
  }

  finish(result) {
    if (this.finished) return;
    this.finished = true;
    this.active = false;
    this.popup = null;
    if (this.keyHandler) {
      this.input.removeListener('keypress', this.keyHandler);
      this.keyHandler = null;
    }
    if (this.input.isTTY) {
      try {
        this.input.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    // 收起盒子，只留下光标在下一行
    this.clearDrawn();
    this.output.write('\n');
    const resolve = this.resolveQuestion;
    this.resolveQuestion = null;
    if (resolve) resolve(result);
  }

  /** 正文输出前：收起输入框 */
  suspend() {
    this.popup = null;
    this.clearDrawn();
  }

  /** 正文输出结束后：重画输入框 */
  resume() {
    if (!this.active) return;
    this.resetFrame();
    this.draw();
  }

  /* ------------------------------ 绘制 ------------------------------ */

  /** 盒子宽度：优先用输出流自己的列数（测试与嵌入式场景可覆盖），否则取终端宽度 */
  width() {
    const columns = Number(this.output.columns) || termWidth();
    return Math.max(20, Math.min(columns - 1, 100));
  }

  /** 当前输出流是否适合用 Unicode 框线 */
  unicode() {
    return useUnicode(this.output);
  }

  /** 计算盒子的所有行（不含光标定位） */
  boxLines() {
    const width = this.width();
    const inner = width - 2;
    const unicode = this.unicode();
    const box = unicode
      ? { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' }
      : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

    const text = this.displayText();
    const empty = text.length === 0;

    // 内容行：按内宽折行
    const rawLines = empty ? [this.placeholder] : wrapDisplay(text, inner);
    const lines = [];
    let cursorRow = 0;
    let cursorCol = 0;

    rawLines.forEach((line, row) => {
      const visible = empty ? COLORS.faint(line) : line;
      // 内容行 = 左竖线 + 空格 + 文本 + 填充 + 右竖线，总宽必须等于 width
      const fill = Math.max(0, inner - 1 - displayWidth(line));
      lines.push(`${box.v} ${visible}${' '.repeat(fill)}${box.v}`);
      if (!empty) {
        // 光标所在行：用「到当前行累计宽度」判断
        const beforeAll = wrapDisplay(text.slice(0, this.cursorDisplayIndex()), inner);
        if (row === beforeAll.length - 1) {
          cursorRow = row;
          cursorCol = 2 + displayWidth(beforeAll[beforeAll.length - 1] || '');
        }
      } else {
        cursorRow = 0;
        cursorCol = 2;
      }
    });

    const top = `${box.tl}${box.h.repeat(width - 2)}${box.tr}`;
    const bottom = `${box.bl}${box.h.repeat(width - 2)}${box.br}`;
    return { top, bottom, lines, cursorRow, cursorCol, width };
  }

  /**
   * 绘制输入区。
   * - 支持光标上移：画出完整盒子（有菜单时连同菜单），之后原地擦除重绘；
   * - 不支持：降级为单行提示，避免无法擦除导致界面叠加。
   */
  draw() {
    if (!this.active) return;

    if (!this.caps.cursorUp) {
      this.drawInline();
      return;
    }

    this.drawAll();
  }

  /**
   * 降级绘制：只用 \r + 空格覆盖当前物理行。
   * 格式：❯ <文字>，超宽时横向滚动，保证永远只有一个物理行。
   */
  drawInline() {
    const width = this.width();
    const marker = this.unicode() ? '❯ ' : '> ';
    const prefix = `${COLORS.accent(marker)}`;
    const available = Math.max(10, width - displayWidth(marker));

    let text = this.displayText();
    if (!text) {
      const placeholder = truncate(this.placeholder || '', available);
      this.repaintLine(`${prefix}${COLORS.faint(placeholder)}`);
      this.moveCursorBack(available - displayWidth(placeholder) + (this.unicode() ? 2 : 2));
      return;
    }

    // 超宽时保留光标附近的窗口
    let cursorWidth = displayWidth(Array.from(text).slice(0, this.cursor).join(''));
    let shown = truncate(text, available);
    let cursorInShown = Math.min(cursorWidth, displayWidth(shown));
    if (displayWidth(text) > available) {
      const keep = Math.max(0, available - 4);
      const startWidth = Math.max(0, cursorWidth - keep);
      let acc = 0;
      let cut = 0;
      const chars = Array.from(text);
      while (cut < chars.length && acc < startWidth) {
        acc += displayWidth(chars[cut]);
        cut += 1;
      }
      const marker2 = this.unicode() ? '…' : '...';
      shown = marker2 + chars.slice(cut).join('');
      shown = truncate(shown, available);
      cursorInShown = displayWidth(marker2) + (cursorWidth - acc);
      if (cursorInShown > available) cursorInShown = available;
    }

    this.repaintLine(`${prefix}${shown}`);
    const back = displayWidth(shown) - cursorInShown;
    if (back > 0) this.moveCursorBack(back);
  }

  /** 用 \r 覆盖当前行并擦掉多余尾部 */
  repaintLine(text) {
    const visible = displayWidth(text);
    const previous = displayWidth(this.onScreen);
    const pad = Math.max(0, previous - visible);
    this.output.write(`\r${text}${' '.repeat(pad)}`);
    if (pad) this.output.write('\b'.repeat(pad));
    this.onScreen = text;
  }

  moveCursorBack(count) {
    if (count > 0) this.output.write('\b'.repeat(count));
  }

  clearDrawn() {
    if (this.caps.cursorUp && this.drawnRows) {
      this.eraseFrame();
      this.resetFrame();
      return;
    }
    if (this.onScreen) {
      this.output.write(`\r${' '.repeat(displayWidth(this.onScreen))}\r`);
      this.onScreen = '';
    }
    this.resetFrame();
  }

  /* ------------------------------ 文本工具 ------------------------------ */

  displayText() {
    return this.value.replace(/\n/g, ` ${this.newlineMark} `);
  }

  cursorDisplayIndex() {
    const before = Array.from(this.value.slice(0, this.cursor));
    let length = 0;
    for (const char of before) {
      if (char === '\n') length += 1 + this.newlineMark.length + 1;
      else length += char.length;
    }
    return length;
  }

  /* ------------------------------ 补全菜单 ------------------------------ */

  menuItems() {
    if (!this.completer) return null;
    return this.completer(this.value, this.cursor);
  }

  openMenu() {
    const trigger = this.menuItems();
    if (!trigger || !trigger.items.length) return false;
    this.popup = { ...trigger, index: 0 };
    this.drawMenu();
    return true;
  }

  /**
   * 统一重绘：菜单（若有）+ 输入框作为一个整体，先整体擦除再整体画出。
   * 这样菜单开合、上下选择、宽度变化都不会留下残影。
   */
  drawAll() {
    if (!this.active) return;
    if (!this.caps.cursorUp) {
      this.drawInline();
      return;
    }
    // 先擦除上一次的框架（记录过几何信息）
    if (this.drawnRows) this.eraseFrame();

    const rows = [];
    let menuRowCount = 0;
    if (this.popup) {
      const menu = this.menuRows();
      menuRowCount = menu.length;
      rows.push(...menu);
    }
    const box = this.boxLines();
    rows.push(box.top, ...box.lines, box.bottom);
    const boxTop = menuRowCount;

    // 逐行写出。注意：每行末尾的 \n 会把光标推到下一行；最后一行的 \n 让光标
    // 落在「框架下方一行」，eraseFrame 正是按这个前提计算回退行数的。
    for (const row of rows) this.output.write(`${row}\n`);

    // 记住几何位置，下次擦除时据此回到框架顶部
    // 注意：写出最后一行后光标落在「框架下方一行」（索引 = rows.length），
    // 而 frameCursorRow 是「光标目标行」在这套坐标里的索引，从 0 开始数：
    //   菜单第 0 行 … 菜单最后一行 → 顶框 → 内容行 … → 底框
    this.drawnRows = rows.length;
    this.frameBoxTop = boxTop;
    this.frameCursorRow = boxTop + 1 + box.cursorRow;

    // 光标从「框架下方一行」上移到目标行，距离 = rows.length - frameCursorRow
    const up = this.drawnRows - this.frameCursorRow;
    if (up > 0) this.output.write(cursorUp(up));
    this.output.write('\r');
    if (box.cursorCol > 0) this.output.write(`\x1b[${box.cursorCol}C`);
  }

  /**
   * 擦除上一次画出的框架，并把光标停在「框架顶行、第 0 列」。
   *
   * 这是整个编辑器最容易出错的地方，做法必须精确：
   *   1. 从光标所在行上移到框架顶行、回到第 0 列；
   *   2. 逐行「清行」，然后把光标移到下一行的第 0 列 —— 用 ESC[nE 而不是写 '\n'，
   *      因为窗口底部写 '\n' 会触发终端向上滚屏，行距就错位了；
   *   3. 走到框架下方后，一次性上移 rows 行回到顶行。
   * 只用到 A / E / 2K，没有别的依赖；框线恰好占满终端宽度也不会自动换行。
   */
  eraseFrame() {
    if (!this.drawnRows) return;
    const rows = this.drawnRows;
    const fromCursor = this.frameCursorRow || 0;
    this.output.write('\r');
    if (fromCursor > 0) this.output.write(cursorUp(fromCursor));
    this.output.write('\r');
    for (let i = 0; i < rows; i += 1) {
      // eraseLine() 返回字符串 `\x1b[2K`；注意不能用 clearLine()（它会直接写 stdout 并返回 undefined）
      this.output.write(eraseLine());
      this.output.write('\x1b[1E'); // 清完这一行，下去一行的第 0 列
    }
    // 此时光标在框架下方第 rows 行，抬回顶部
    this.output.write(cursorUp(rows));
    this.output.write('\r');
  }

  /** 清掉记下的几何信息：下一次 drawAll 会从光标所在行从头画起 */
  resetFrame() {
    this.drawnRows = 0;
    this.frameCursorRow = 0;
    this.frameBoxTop = 0;
  }

  /** 菜单的每一行（宽度与输入框一致） */
  menuRows() {
    const { items, index, title, hint } = this.popup;
    const width = this.width();
    const inner = width - 2;
    const unicode = this.unicode();
    const v = unicode ? '│' : '|';
    const tl = unicode ? '┌' : '+';
    const bl = unicode ? '└' : '+';
    const tr = unicode ? '┐' : '+';
    const br = unicode ? '┘' : '+';
    const h = unicode ? '─' : '-';

    const pageSize = 8;
    const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), Math.max(0, items.length - pageSize)));
    const shown = items.slice(start, start + pageSize);

    const rows = [];
    const headLabel = ` ${title || 'Menu'} `;
    const headFill = Math.max(0, width - 2 - displayWidth(headLabel));
    rows.push(`${tl}${COLORS.bold(headLabel)}${h.repeat(headFill)}${tr}`);

    shown.forEach((item, i) => {
      const realIndex = start + i;
      const active = realIndex === index;
      const marker = active ? COLORS.accent('›') : ' ';
      const label = truncate(item.label, Math.max(8, inner - 6));
      const hintWidth = Math.max(0, inner - 4 - displayWidth(label));
      const tail = item.hint && hintWidth > 6 ? COLORS.faint(`  ${truncate(item.hint, hintWidth)}`) : '';
      const body = `${marker} ${active ? COLORS.accent(label) : label}${tail}`;
      const fill = Math.max(0, inner - displayWidth(`${marker} ${label}${tail ? `  ${truncate(item.hint, hintWidth)}` : ''}`));
      rows.push(`${COLORS.faint(v)} ${body}${' '.repeat(fill)}${COLORS.faint(v)}`);
    });

    const footer = items.length > shown.length ? ` ${start + 1}-${start + shown.length}/${items.length} ` : '';
    rows.push(`${bl}${h.repeat(Math.max(0, width - 2 - displayWidth(footer)))}${footer}${br}`);
    if (hint) rows.push(COLORS.faint(`  ${hint}`));
    return rows;
  }

  /** 打开/刷新菜单后整体重绘 */
  drawMenu() {
    this.drawAll();
  }

  closeMenu() {
    if (!this.popup) return;
    this.popup = null;
    this.drawAll();
  }

  applyItem(item) {
    if (!item) return;
    const next = typeof item.apply === 'string' ? item.apply : typeof item.value === 'string' ? item.value : null;
    if (next !== null) {
      this.value = next;
      this.cursor = Array.from(next).length;
    }
  }

  /* ------------------------------ 编辑 ------------------------------ */

  insert(text) {
    const chars = Array.from(this.value);
    const insertChars = Array.from(text);
    chars.splice(this.cursor, 0, ...insertChars);
    this.cursor += insertChars.length;
    this.value = chars.join('');
  }

  pushHistory(entry) {
    const text = String(entry || '').trim();
    if (!text) return;
    if (this.history[this.history.length - 1] === text) return;
    this.history.push(text);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    this.historyIndex = this.history.length;
  }

  /** 取上一条可回填的内容：优先用户提示词，其次普通历史 */
  previousEntry() {
    if (this.lastUserPrompt) return this.lastUserPrompt;
    if (this.history.length) return this.history[this.history.length - 1];
    return '';
  }

  /* ------------------------------ 按键 ------------------------------ */

  async handleKey(str, key) {
    if (!this.active) return;
    const ctrl = Boolean(key.ctrl);
    const chars = Array.from(this.value);
    const isSubmit = key.name === 'return' || key.name === 'enter' || str === '\r' || str === '\n';

    /* --- 菜单激活时优先处理 --- */
    if (this.popup) {
      const { items } = this.popup;
      if (key.name === 'up') {
        this.popup.index = (this.popup.index - 1 + items.length) % items.length;
        this.drawMenu();
        return;
      }
      if (key.name === 'down') {
        this.popup.index = (this.popup.index + 1) % items.length;
        this.drawMenu();
        return;
      }
      if (key.name === 'escape') {
        this.closeMenu();
        return;
      }
      if (key.name === 'tab') {
        // Tab 补全当前选中项
        this.applyItem(items[this.popup.index]);
        this.popup = null;
        this.draw();
        return;
      }
      if (isSubmit) {
        // Enter 执行当前选中项
        this.applyItem(items[this.popup.index]);
        this.popup = null;
        this.submit();
        return;
      }
      if (key.name === 'backspace') {
        if (this.cursor > 0) {
          chars.splice(this.cursor - 1, 1);
          this.cursor -= 1;
          this.value = chars.join('');
        }
        this.popup = null;
        this.draw();
        return;
      }
      // 其他字符：关闭菜单继续输入
      this.popup = null;
      this.draw();
    }

    /* --- 控制键 --- */
    if (ctrl && key.name === 'c') {
      if (this.value) {
        this.value = '';
        this.cursor = 0;
        this.draw();
        return;
      }
      this.clearDrawn();
      this.active = false;
      if (this.keyHandler) {
        this.input.removeListener('keypress', this.keyHandler);
        this.keyHandler = null;
      }
      if (this.input.isTTY) {
        try {
          this.input.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      this.output.write(`${COLORS.dim('^C')}\n`);
      const handled = this.abortHandler ? await this.abortHandler() : false;
      if (handled) {
        this.active = true;
        this.finished = false;
        this.value = '';
        this.cursor = 0;
        this.drawnRows = 0;
        if (this.input.isTTY) {
          try {
            this.input.setRawMode(true);
          } catch {
            /* ignore */
          }
        }
        this.keyHandler = (s, k) => {
          this.keyQueue = this.keyQueue.then(() => this.handleKey(s || '', k || {})).catch(() => {});
        };
        this.input.on('keypress', this.keyHandler);
        this.draw();
        return;
      }
      this.finish({ type: 'cancel', value: '' });
      return;
    }

    if (ctrl && key.name === 'd') {
      if (!this.value) {
        this.finish({ type: 'eof', value: '' });
        return;
      }
      chars.splice(this.cursor, 1);
      this.value = chars.join('');
      this.draw();
      return;
    }

    if (ctrl && key.name === 'u') {
      chars.splice(0, this.cursor);
      this.value = chars.join('');
      this.cursor = 0;
      this.draw();
      return;
    }

    if (ctrl && key.name === 'k') {
      chars.splice(this.cursor);
      this.value = chars.join('');
      this.draw();
      return;
    }

    if (ctrl && key.name === 'w') {
      let i = this.cursor;
      while (i > 0 && /\s/.test(chars[i - 1])) i -= 1;
      while (i > 0 && !/\s/.test(chars[i - 1])) i -= 1;
      chars.splice(i, this.cursor - i);
      this.cursor = i;
      this.value = chars.join('');
      this.draw();
      return;
    }

    if (ctrl && key.name === 'a') {
      this.cursor = 0;
      this.draw();
      return;
    }

    if (ctrl && key.name === 'e') {
      this.cursor = chars.length;
      this.draw();
      return;
    }

    if (ctrl && key.name === 'l') {
      clearScreen(this.output);
      this.drawnRows = 0;
      this.draw();
      return;
    }

    /* --- 回车 / 续行 --- */
    if (isSubmit) {
      if (this.multiline && chars[this.cursor - 1] === '\\') {
        chars.splice(this.cursor - 1, 1, '\n');
        this.value = chars.join('');
        this.draw();
        return;
      }
      this.submit();
      return;
    }

    /* --- 方向键 --- */
    if (key.name === 'up') {
      // ↑ 回填上一条用户提示词
      const previous = this.previousEntry();
      if (previous && !this.value) {
        this.value = previous;
        this.cursor = Array.from(previous).length;
        this.draw();
      }
      return;
    }
    if (key.name === 'down') {
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex += 1;
        this.value = this.history[this.historyIndex] || '';
        this.cursor = Array.from(this.value).length;
      } else {
        this.historyIndex = this.history.length;
        this.value = this.draft;
        this.cursor = Array.from(this.value).length;
      }
      this.draw();
      return;
    }
    if (key.name === 'left') {
      this.cursor = Math.max(0, this.cursor - 1);
      this.draw();
      return;
    }
    if (key.name === 'right') {
      this.cursor = Math.min(chars.length, this.cursor + 1);
      this.draw();
      return;
    }
    if (key.name === 'home') {
      this.cursor = 0;
      this.draw();
      return;
    }
    if (key.name === 'end') {
      this.cursor = chars.length;
      this.draw();
      return;
    }

    /* --- 删除 --- */
    if (key.name === 'backspace') {
      if (this.cursor > 0) {
        chars.splice(this.cursor - 1, 1);
        this.cursor -= 1;
        this.value = chars.join('');
        this.draw();
      }
      return;
    }
    if (key.name === 'delete') {
      if (this.cursor < chars.length) {
        chars.splice(this.cursor, 1);
        this.value = chars.join('');
        this.draw();
      }
      return;
    }

    /* --- Tab：打开或切换菜单 --- */
    if (key.name === 'tab') {
      if (!this.popup) this.openMenu();
      return;
    }

    if (key.name === 'escape') {
      return;
    }

    /* --- 普通字符 --- */
    if (str && !ctrl && !key.meta) {
      const filtered = String(str).replace(/[\r\n]/g, '');
      if (filtered) {
        this.insert(filtered);
        this.draw();
      }
    }
  }

  submit() {
    const value = this.value;
    this.value = '';
    this.cursor = 0;
    this.popup = null;
    this.historyIndex = this.history.length;
    this.draft = '';
    this.finish({ type: 'submit', value });
  }
}

/* ------------------------------ 文本折行 ------------------------------ */

/** 按显示宽度把文本折成多行 */
function wrapDisplay(text, width) {
  const limit = Math.max(4, width);
  const out = [];
  let line = '';
  let lineWidth = 0;
  for (const char of String(text ?? '')) {
    const w = displayWidth(char);
    if (lineWidth + w > limit) {
      out.push(line);
      line = '';
      lineWidth = 0;
    }
    line += char;
    lineWidth += w;
  }
  out.push(line);
  return out.length ? out : [''];
}

/* ------------------------------ 非 TTY 回退 ------------------------------ */

function createLineReader(stream = process.stdin) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const iterator = rl[Symbol.asyncIterator]();
  let closed = false;
  return {
    async question() {
      if (closed) return { type: 'eof', value: '' };
      const { value, done } = await iterator.next();
      if (done) {
        closed = true;
        rl.close();
        return { type: 'eof', value: '' };
      }
      return { type: 'submit', value };
    },
    setAbortHandler() {},
    history: [],
    lastUserPrompt: '',
    pushHistory() {},
    suspend() {},
    resume() {},
    finish(result) {
      closed = true;
      rl.close();
      return result;
    },
    get prompt() {
      return '';
    },
    set prompt(value) {
      void value;
    }
  };
}

module.exports = { LineEditor, createLineReader, detectCapabilities, wrapDisplay, t };
