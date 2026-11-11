'use strict';

/**
 * 简易 ANSI 终端模拟器：按「显示宽度」维护字符网格（中文占两列）。
 * 支持：可打印字符、\r、\n、\b、ESC[nA/B/C/D/E/F、ESC[2K、ESC[2J、ESC[H 以及颜色序列（忽略）。
 *
 * 宽字符判定直接复用 src/cli/ansi.js 的 displayWidth —— 模拟器和被测代码必须用
 * 同一套宽度规则，否则像制表符（U+2500 区段）这种 East Asian Ambiguous 字符会出现
 * 「模拟器算 2 列、代码算 1 列」的错位，把框线挤换行，测试结果全是假的。
 */

const { displayWidth } = require('../src/cli/ansi');

function charWidth(ch) {
  return displayWidth(ch);
}

class Term {
  constructor(width = 72, height = 400) {
    this.width = width;
    this.height = height;
    /** 模拟 Node 的 process.stdout.columns */
    this.columns = width;
    this.isTTY = true;
    this.grid = [this._blank()];
    this.row = 0;
    this.col = 0;
    this.raw = '';
  }

  _blank() {
    return Array.from({ length: this.width }, () => ' ');
  }

  _ensureRow(index) {
    while (index >= this.grid.length) this.grid.push(this._blank());
  }

  /**
   * 把光标移到行 index 并确保该行存在。
   * 真实终端里光标永远停在某个物理行上，绝不会「停在末尾之外」，
   * 所以移动前先把中间缺的行补齐 —— 这是保证行号与行内容一一对应的关键。
   */
  _goto(index) {
    const target = Math.max(0, index);
    this._ensureRow(target);
    this.row = target;
  }

  write(chunk) {
    const text = String(chunk);
    this.raw += text;
    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (ch === '\x1b') {
        const rest = text.slice(i);
        const m = rest.match(/^\x1b\[([0-9;?]*)([A-Za-z])/);
        if (!m) {
          i += 2;
          continue;
        }
        const params = m[1];
        const command = m[2];
        const n = Number(params) || 1;
        switch (command) {
          case 'A': // CUU 上移
            this._goto(this.row - n);
            break;
          case 'B': // CUD 下移
            this._goto(this.row + n);
            break;
          case 'C': // CUF 右移
            this.col = Math.min(this.width - 1, this.col + n);
            break;
          case 'D': // CUB 左移
            this.col = Math.max(0, this.col - n);
            break;
          case 'E': // CNL 下移并回到行首
            this._goto(this.row + n);
            this.col = 0;
            break;
          case 'F': // CPL 上移并回到行首
            this._goto(this.row - n);
            this.col = 0;
            break;
          case 'K': // EL 清整行
            this._ensureRow(this.row);
            this.grid[this.row] = this._blank();
            break;
          case 'J': // ED 清屏
            if (params === '2') {
              this.grid = [this._blank()];
              this.row = 0;
              this.col = 0;
            }
            break;
          case 'H': // CUP 回左上角
            this.row = 0;
            this.col = 0;
            break;
          default:
            break;
        }
        i += m[0].length;
        continue;
      }

      if (ch === '\r') {
        this.col = 0;
      } else if (ch === '\n') {
        this._goto(this.row + 1);
        this.col = 0;
      } else if (ch === '\b') {
        this.col = Math.max(0, this.col - 1);
      } else if (ch === '\t') {
        this.col = Math.min(this.width - 1, (Math.floor(this.col / 8) + 1) * 8);
      } else {
        this._ensureRow(this.row);
        const w = charWidth(ch);
        if (w > 0 && this.col + w <= this.width) {
          this.grid[this.row][this.col] = ch;
          if (w === 2 && this.col + 1 < this.width) this.grid[this.row][this.col + 1] = '';
          this.col += w;
        }
      }
      i += 1;
    }
    return true;
  }

  get lines() {
    return this.grid.map((row) => row.join('').replace(/\s+$/, ''));
  }
}

module.exports = { Term, charWidth };
