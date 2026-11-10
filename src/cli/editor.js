'use strict';

/**
 * 行编辑器：支持中文输入、历史、自动补全、多行输入，以及在流式输出期间中断。
 *
 * 终端兼容性（实测得出）：部分 Windows 控制台会忽略 `\x1b[nA`（光标上移）、
 * `\x1b[nC`（光标右移）等序列，凡是依赖它们做「擦除重画」的实现，
 * 都会退化成「每敲一个字就多印一行」。所以这里只用最基础的能力：
 *   - `\r` 回到当前行行首；
 *   - 空格覆盖多余内容；
 *   - 需要时整行重写（单行内完成，绝不跨行）。
 *
 * 多行输入（行尾 `\`）不支持跨行光标定位，改为在提示行里用 ⏎ 标记显示换行，
 * 提交时再还原成真正的换行，功能不减、显示稳定。
 */

const readline = require('readline');
const { COLORS, displayWidth, truncate, termWidth, useUnicode, isInteractive } = require('./ansi');

class LineEditor {
  constructor(options = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.prompt = options.prompt || '> ';
    this.history = Array.isArray(options.history) ? options.history.slice() : [];
    this.historyIndex = this.history.length;
    this.completer = options.completer || null;
    this.multiline = options.multiline !== false;
    this.maxHistory = options.maxHistory || 500;

    this.value = '';
    this.cursor = 0;
    /** 当前提示行屏幕上的实际内容（含提示符），用于 \r 覆盖时擦尾巴 */
    this.onScreen = '';
    this.popup = null;
    this.draft = '';
    this.active = false;
    this.finished = false;
    this.resolveQuestion = null;
    this.keyHandler = null;
    this.keyQueue = Promise.resolve();
    this.abortHandler = null;
    this.newlineMark = useUnicode() ? '⏎' : '\\n';
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
    this.onScreen = '';
    this.historyIndex = this.history.length;
    this.active = true;
    this.finished = false;

    return new Promise((resolve) => {
      this.resolveQuestion = resolve;
      readline.emitKeypressEvents(this.input);
      if (this.input.isTTY) {
        try {
          this.input.setRawMode(true);
        } catch {
          /* ignore */
        }
      }
      this.input.resume();

      this.keyHandler = (str, key) => {
        // 按键必须按顺序处理：handleKey 是异步的（Ctrl+C 可能等待中断回调），
        // 用队列串行化，避免快速输入时状态错乱。
        this.keyQueue = this.keyQueue.then(() => this.handleKey(str || '', key || {})).catch(() => {});
      };
      this.input.on('keypress', this.keyHandler);
      this.repaint();
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
    // 提交时保留用户看到的那一行，只把光标移到下一行开头
    this.output.write('\n');
    this.onScreen = '';
    const resolve = this.resolveQuestion;
    this.resolveQuestion = null;
    if (resolve) resolve(result);
  }

  /** 流式输出前：把提示行清掉，让输出独占终端 */
  suspend() {
    this.popup = null;
    this.clearLine();
  }

  /** 流式输出结束后：重新画出提示行 */
  resume() {
    if (!this.active) return;
    this.onScreen = '';
    this.repaint();
  }

  /* ------------------------------ 屏幕操作 ------------------------------ */

  /** 用 \r + 空格覆盖当前物理行（不跨行、不用 ANSI 光标序列） */
  writeLine(text) {
    const visible = displayWidth(text);
    const previous = displayWidth(this.onScreen);
    const pad = Math.max(0, previous - visible);
    this.output.write(`\r${text}${' '.repeat(pad)}`);
    // 把光标退回行尾，方便下一次覆盖
    if (pad) this.output.write('\b'.repeat(pad));
    this.onScreen = text;
  }

  clearLine() {
    if (!this.onScreen) {
      this.output.write('\r');
      return;
    }
    const width = displayWidth(this.onScreen);
    this.output.write(`\r${' '.repeat(width)}\r`);
    this.onScreen = '';
  }

  /* ------------------------------ 绘制 ------------------------------ */

  /** 把内部文本转成单行显示：换行用 ⏎ 表示（部分终端不支持跨行光标定位） */
  displayText() {
    return this.value.replace(/\n/g, ` ${this.newlineMark} `);
  }

  /** 计算光标在显示文本中的位置 */
  cursorDisplayIndex() {
    const before = Array.from(this.value.slice(0, this.cursor));
    let length = 0;
    for (const char of before) {
      if (char === '\n') length += 1 + this.newlineMark.length + 1;
      else length += char.length;
    }
    return length;
  }

  repaint() {
    if (!this.active) return;
    const promptText = this.prompt;
    const promptWidth = displayWidth(promptText);
    const totalWidth = Math.max(20, termWidth() - 1);
    const available = Math.max(10, totalWidth - promptWidth);

    let text = this.displayText();
    let cursor = this.cursorDisplayIndex();

    // 超宽时横向滚动：保留光标前后一部分，避免行被终端自动折行（折行后无法定位）
    let offset = 0;
    if (displayWidth(text) > available) {
      const beforeCursor = Array.from(text).slice(0, cursor);
      const cursorWidth = displayWidth(beforeCursor.join(''));
      if (cursorWidth > available - 4) {
        // 从前面裁掉
        let cut = 0;
        let removed = 0;
        const target = cursorWidth - (available - 8);
        while (cut < beforeCursor.length && removed < target) {
          removed += displayWidth(beforeCursor[cut]);
          cut += 1;
        }
        const head = useUnicode() ? '…' : '...';
        text = head + Array.from(text).slice(cut).join('');
        offset = displayWidth(head);
        cursor = cursor - removed + offset;
      }
    }

    const clipped = truncate(text, Math.max(1, available));
    this.writeLine(`${promptText}${clipped}`);

    // 光标定位：从行尾往回退（依赖 \b，不依赖 ANSI 光标序列）
    const endWidth = promptWidth + displayWidth(clipped);
    const back = endWidth - (promptWidth + cursor);
    if (back > 0) this.output.write('\b'.repeat(back));
  }

  /* ------------------------------ 补全弹层 ------------------------------ */

  refreshPopup() {
    if (!this.active) return;
    const trigger = this.completer ? this.completer(this.value, this.cursor) : null;
    if (!trigger || !trigger.items || !trigger.items.length) {
      this.popup = null;
      this.repaint();
      return;
    }
    let index = 0;
    if (this.popup && this.popup.items[this.popup.index]) {
      const previous = this.popup.items[this.popup.index].apply || this.popup.items[this.popup.index].label;
      const found = trigger.items.findIndex((item) => (item.apply || item.label) === previous);
      if (found >= 0) index = found;
    }
    this.popup = { ...trigger, index };
    this.repaint();
    this.drawPopup();
  }

  /**
   * 弹层只在下方的临时区域显示候选，输入提示行始终是最后一行。
   * 由于部分终端不支持光标回退，这里不会把提示行往上搬，而是在下方列出候选后重画提示行。
   */
  drawPopup() {
    if (!this.popup) return;
    const { items, index, title } = this.popup;
    if (!items.length) return;
    const width = Math.min(64, termWidth() - 4);

    // 先把提示行清掉，候选从空行开始打印
    this.clearLine();
    this.output.write('\n');
    if (title) this.output.write(`${COLORS.faint(`  ${title}`)}\n`);
    const shown = items.slice(0, 12);
    shown.forEach((item, i) => {
      const active = i === index;
      const label = truncate(item.label, width - 8);
      const hintWidth = Math.max(0, width - 10 - displayWidth(label));
      const hint = item.hint && hintWidth > 4 ? COLORS.faint(`  ${truncate(item.hint, hintWidth)}`) : '';
      this.output.write(`${active ? COLORS.accent('›') : ' '} ${active ? COLORS.accent(label) : label}${hint}\n`);
    });
    if (items.length > shown.length) {
      this.output.write(COLORS.faint(`  …还有 ${items.length - shown.length} 项\n`));
    }

    // 重画提示行，让它回到最下方
    this.onScreen = '';
    this.repaint();
  }

  closePopup() {
    if (!this.popup) return;
    this.popup = null;
    this.repaint();
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

  /* ------------------------------ 按键 ------------------------------ */

  async handleKey(str, key) {
    if (!this.active) return;
    const ctrl = Boolean(key.ctrl);
    const chars = Array.from(this.value);
    const isSubmitKey = key.name === 'return' || key.name === 'enter' || str === '\r' || str === '\n';

    /* --- 弹层激活 --- */
    if (this.popup) {
      const { items } = this.popup;
      if (key.name === 'up') {
        this.popup.index = (this.popup.index - 1 + items.length) % items.length;
        this.drawPopup();
        return;
      }
      if (key.name === 'down' || key.name === 'tab') {
        this.popup.index = (this.popup.index + 1) % items.length;
        this.drawPopup();
        return;
      }
      if (key.name === 'escape') {
        this.popup = null;
        this.repaint();
        return;
      }
      if (isSubmitKey) {
        const item = items[this.popup.index];
        this.popup = null;
        if (item) {
          // 注意：不能写 `this.completer.apply(...)` —— 那是 Function.prototype.apply，
          // 永远存在，会把补全器的返回值吃成 undefined。这里只认显式的 applyItem 方法，
          // 否则回落到 item 上的 apply 字符串。
          let applied = null;
          if (this.completer && typeof this.completer.applyItem === 'function') {
            applied = this.completer.applyItem(this.value, this.cursor, item);
          }
          if (applied && typeof applied.value === 'string') {
            this.value = applied.value;
            this.cursor = Number.isInteger(applied.cursor) ? applied.cursor : Array.from(applied.value).length;
          } else if (typeof item.apply === 'string') {
            this.value = item.apply;
            this.cursor = Array.from(item.apply).length;
          } else if (typeof item.value === 'string') {
            this.value = item.value;
            this.cursor = Array.from(item.value).length;
          }
          this.repaint();
          // 补全后把选择权交回用户：再按一次回车才提交
          return;
        }
      }
    }

    /* --- 控制键 --- */
    if (ctrl && key.name === 'c') {
      if (this.value) {
        this.value = '';
        this.cursor = 0;
        this.popup = null;
        this.repaint();
        return;
      }
      this.clearLine();
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
        this.onScreen = '';
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
        this.repaint();
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
      this.repaint();
      return;
    }

    if (ctrl && key.name === 'u') {
      chars.splice(0, this.cursor);
      this.value = chars.join('');
      this.cursor = 0;
      this.repaint();
      return;
    }

    if (ctrl && key.name === 'k') {
      chars.splice(this.cursor);
      this.value = chars.join('');
      this.repaint();
      return;
    }

    if (ctrl && key.name === 'w') {
      let i = this.cursor;
      while (i > 0 && /\s/.test(chars[i - 1])) i -= 1;
      while (i > 0 && !/\s/.test(chars[i - 1])) i -= 1;
      chars.splice(i, this.cursor - i);
      this.cursor = i;
      this.value = chars.join('');
      this.repaint();
      return;
    }

    if (ctrl && key.name === 'a') {
      this.cursor = 0;
      this.repaint();
      return;
    }

    if (ctrl && key.name === 'e') {
      this.cursor = chars.length;
      this.repaint();
      return;
    }

    if (ctrl && key.name === 'l') {
      this.output.write('\x1b[2J\x1b[H');
      this.onScreen = '';
      this.repaint();
      return;
    }

    /* --- 回车 --- */
    if (isSubmitKey) {
      if (this.multiline && chars[this.cursor - 1] === '\\') {
        chars.splice(this.cursor - 1, 1, '\n');
        this.value = chars.join('');
        this.repaint();
        return;
      }
      this.submit();
      return;
    }

    /* --- 光标与删除 --- */
    if (key.name === 'backspace') {
      if (this.cursor > 0) {
        chars.splice(this.cursor - 1, 1);
        this.cursor -= 1;
        this.value = chars.join('');
        this.refreshPopup();
      }
      return;
    }
    if (key.name === 'delete') {
      if (this.cursor < chars.length) {
        chars.splice(this.cursor, 1);
        this.value = chars.join('');
        this.refreshPopup();
      }
      return;
    }
    if (key.name === 'left') {
      this.cursor = Math.max(0, this.cursor - 1);
      this.popup = null;
      this.repaint();
      return;
    }
    if (key.name === 'right') {
      this.cursor = Math.min(chars.length, this.cursor + 1);
      this.popup = null;
      this.repaint();
      return;
    }
    if (key.name === 'home') {
      this.cursor = 0;
      this.repaint();
      return;
    }
    if (key.name === 'end') {
      this.cursor = chars.length;
      this.repaint();
      return;
    }
    if (key.name === 'up') {
      if (!this.history.length) return;
      if (this.historyIndex === this.history.length) this.draft = this.value;
      this.historyIndex = Math.max(0, this.historyIndex - 1);
      this.value = this.history[this.historyIndex] || '';
      this.cursor = Array.from(this.value).length;
      this.popup = null;
      this.repaint();
      return;
    }
    if (key.name === 'down') {
      if (this.historyIndex >= this.history.length) return;
      this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
      this.value = this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex] || '';
      this.cursor = Array.from(this.value).length;
      this.popup = null;
      this.repaint();
      return;
    }
    if (key.name === 'tab') {
      this.refreshPopup();
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
        this.repaint();
      }
    }
  }

  submit() {
    const value = this.value;
    this.value = '';
    this.cursor = 0;
    this.popup = null;
    this.finish({ type: 'submit', value });
  }
}

/* ------------------------------ 非 TTY 回退 ------------------------------ */

/**
 * 非 TTY（管道 / 重定向）用的极简行读取：不做任何光标控制。
 */
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

module.exports = { LineEditor, createLineReader };
