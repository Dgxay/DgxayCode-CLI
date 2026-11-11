'use strict';

/**
 * 流式渲染：把 agent 事件流翻译成终端输出。
 *
 * 终端兼容性：只用 `\r` 回行首、空格擦尾、`\b` 退光标这些最基础能力，
 * 不依赖光标上移（部分 Windows 控制台会忽略）。
 *
 * 三段输出：
 *   1. 思考：实时显示计时 + 思考内容（超长时只保留末尾几行），结束后折叠成一行摘要；
 *   2. 正文：流式期间只在最后一行刷新预览，结束时一次性按 Markdown 排版；
 *   3. 工具：单行状态 + 结果摘要。
 */

const { COLORS, SIGN, displayWidth, truncate, termWidth, renderMarkdown } = require('./ansi');
const { t } = require('./i18n');

const TOOL_KEYS = {
  list_directory: 'tool_list',
  read_file: 'tool_read',
  write_file: 'tool_write',
  create_directory: 'tool_mkdir',
  delete_path: 'tool_delete',
  run_command: 'tool_command',
  fetch_url: 'tool_fetch',
  install_mcp_server: 'tool_mcp'
};

function toolSummary(name, argsRaw) {
  let args = {};
  try {
    args = argsRaw ? JSON.parse(argsRaw) : {};
  } catch {
    args = {};
  }
  const title = t(TOOL_KEYS[name] || name);
  const target = args.path || args.url || args.command || args.name || '';
  return target
    ? `${title} ${truncate(String(target).replace(/\s+/g, ' '), Math.max(20, termWidth() - 24))}`
    : title;
}

/** 按显示宽度折行（纯文本预览用） */
function foldLine(text, width) {
  const limit = Math.max(20, width);
  if (displayWidth(text) <= limit) return [text];
  const out = [];
  let current = '';
  let currentWidth = 0;
  for (const char of text) {
    const w = displayWidth(char);
    if (currentWidth + w > limit) {
      out.push(current);
      current = '';
      currentWidth = 0;
    }
    current += char;
    currentWidth += w;
  }
  if (current) out.push(current);
  return out.length ? out : [''];
}

function formatSeconds(ms) {
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

class StreamRenderer {
  constructor(options = {}) {
    this.out = options.output || process.stdout;
    this.editor = options.editor || null;
    const tty = Boolean(this.out.isTTY);
    this.live = options.redraw !== undefined ? Boolean(options.redraw) : tty;
    this.width = Math.max(20, (options.width || termWidth()) - 1);
    /** 是否显示思考内容（默认 true；DGXAY_SHOW_REASONING=0 可关闭） */
    this.showReasoning = process.env.DGXAY_SHOW_REASONING !== '0';
    /** 思考内容最多显示几行 */
    this.reasoningLines = Number(process.env.DGXAY_REASONING_LINES) || 6;
    this.timer = null;
    this.reset();
  }

  reset() {
    this.started = false;
    this.text = '';
    this.onScreen = '';
    this.newlines = 0;
    this.tools = new Map();

    this.reasoning = '';
    this.reasoningStart = 0;
    this.reasoningMs = 0;
    this.reasoningRows = 0;
    this.reasoningDone = false;
    this.suspended = false;
    this.statusShown = false;
  }

  /* ------------------------------ 编辑器协调 ------------------------------ */

  suspend() {
    if (this.suspended) return;
    this.editor?.suspend();
    this.suspended = true;
  }

  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this.editor?.resume();
  }

  /* ------------------------------ 基础绘制 ------------------------------ */

  repaintLine(text) {
    const visible = displayWidth(text);
    const previous = displayWidth(this.onScreen);
    const pad = Math.max(0, previous - visible);
    this.out.write(`\r${text}${' '.repeat(pad)}`);
    if (pad) this.out.write('\b'.repeat(pad));
    this.onScreen = text;
  }

  breakLine() {
    this.out.write('\n');
    this.onScreen = '';
  }

  ensureHeader() {
    if (this.started) return;
    this.started = true;
    this.suspend();
    this.out.write(`\n${COLORS.accent('•')} ${COLORS.bold(t('assistant'))}\n`);
    this.onScreen = '';
  }

  /* ------------------------------ 思考 ------------------------------ */

  /** 开始思考：立刻给出提示，用户不用干等 */
  beginReasoning() {
    this.ensureHeader();
    if (this.reasoningStart) return;
    this.reasoningStart = Date.now();
    this.reasoningDone = false;
    this.reasoningRows = 0;
    this.paintReasoning();
    // 每 100ms 刷新一次计时，让用户看到“还在跑”
    this.timer = setInterval(() => this.paintReasoning(), 100);
    this.timer.unref?.();
  }

  /**
   * 把已收到的思考内容画出来（末尾若干行），并带上实时计时。
   * 只用 \r + 空格覆盖当前物理行，不依赖光标上移：
   * - 计时和最新一行思考内容合并在同一行刷新；
   * - 更早的思考内容不逐行打印，避免需要回退光标。
   */
  paintReasoning() {
    if (!this.reasoningStart || this.reasoningDone) return;
    if (!this.live) return;
    const elapsed = Date.now() - this.reasoningStart;
    const width = Math.max(20, this.width - 6);

    if (!this.showReasoning) {
      this.repaintLine(COLORS.faint(`  ${SIGN.run} ${t('thinking')} ${formatSeconds(elapsed)}`));
      return;
    }

    // 最新一行思考内容（把换行压成空格，保持单行刷新）
    const latest = this.reasoning.replace(/\s+/g, ' ').trim();
    const tailText = latest.length > width ? `…${latest.slice(-width)}` : latest;
    const head = `${COLORS.faint(`  ${SIGN.run} ${t('thinking')} ${formatSeconds(elapsed)}`)}`;
    this.repaintLine(tailText ? `${head} ${COLORS.faint(tailText)}` : head);
  }

  /** 思考结束：当前位置就是摘要行，直接覆盖即可，不需要上移光标 */
  endReasoning() {
    if (!this.reasoningStart || this.reasoningDone) return;
    this.reasoningDone = true;
    this.reasoningMs = Date.now() - this.reasoningStart;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.live) {
      // 覆盖掉“思考中”的实时行
      this.repaintLine('');
      this.out.write('\r');
      this.onScreen = '';
    }
    if (this.reasoning.trim()) {
      this.out.write(
        `${COLORS.faint(`  ⌁ ${t('thought_for')} ${formatSeconds(this.reasoningMs)} · ${this.reasoning.length} ${t('chars')}`)}\n`
      );
      // 详细内容用灰色缩进段落呈现，最多若干行，避免刷屏
      if (this.showReasoning) {
        const width = Math.max(20, this.width - 4);
        const lines = [];
        for (const line of this.reasoning.split('\n')) {
          for (const piece of foldLine(line, width)) lines.push(piece);
        }
        const max = Math.max(1, this.reasoningLines);
        const shown = lines.length > max ? lines.slice(-max) : lines;
        if (lines.length > max) this.out.write(`${COLORS.faint('  │ …')}\n`);
        for (const piece of shown) {
          if (piece.trim()) this.out.write(`${COLORS.faint(`  │ ${piece}`)}\n`);
        }
      }
    }
  }

  /* ------------------------------ 正文 ------------------------------ */

  writeText(text) {
    this.endReasoning();
    this.ensureHeader();
    this.text += text;
    this.newlines += (text.match(/\n/g) || []).length;
    if (!this.live) return;

    const lines = this.text.split('\n');
    const tail = lines[lines.length - 1];
    const folded = foldLine(tail, this.width);
    this.repaintLine(folded[folded.length - 1]);
  }

  finalizeText() {
    if (!this.text) {
      this.onScreen = '';
      return;
    }
    if (this.live && this.onScreen) this.repaintLine('');
    const rendered = renderMarkdown(this.text, { width: this.width });
    if (rendered && rendered.trim()) {
      this.out.write(rendered);
      if (!rendered.endsWith('\n')) this.breakLine();
    }
    this.text = '';
    this.newlines = 0;
    this.onScreen = '';
  }

  /* ------------------------------ 事件分发 ------------------------------ */

  handle(event) {
    switch (event.type) {
      case 'status':
        return;
      case 'reasoning':
        if (!event.text) return;
        this.reasoning += event.text;
        this.beginReasoning();
        if (this.showReasoning && this.live) this.paintReasoning();
        return;
      case 'delta':
        if (!event.text) return;
        this.writeText(event.text);
        return;
      case 'tool':
        this.onTool(event);
        return;
      case 'review-start':
        this.endInline();
        this.out.write(`${COLORS.faint(`  ${SIGN.run} ${t('reviewing')} ${event.name}…`)}\n`);
        return;
      case 'review':
        this.endInline();
        if (event.decision === 'allow') {
          this.out.write(
            `${COLORS.green(`  ${SIGN.ok}`)} ${COLORS.green(t('review_allow'))} ${COLORS.faint(
              `${event.reviewer || ''} · ${event.reason || ''}`
            )}\n`
          );
        } else {
          this.out.write(
            `${COLORS.yellow(`  ${SIGN.run}`)} ${COLORS.yellow(t('review_suspect'))} ${COLORS.faint(event.reason || '')}\n`
          );
        }
        return;
      case 'waiting':
        this.endInline();
        this.out.write(`${COLORS.faint(`  ${SIGN.run} ${t('waiting_confirm')} ${event.name}…`)}\n`);
        return;
      case 'file':
        this.endInline();
        this.out.write(
          `${COLORS.green(`  ${SIGN.ok}`)} ${COLORS.dim(
            event.action === 'deleted'
              ? t('file_deleted')
              : event.action === 'updated'
                ? t('file_updated')
                : t('file_created')
          )} ${COLORS.cyan(event.display || event.path)}${event.bytes ? COLORS.faint(` (${event.bytes} B)`) : ''}\n`
        );
        return;
      case 'done':
      case 'error':
      case 'aborted':
        this.finish(event);
        return;
      default:
        return;
    }
  }

  endInline() {
    this.endReasoning();
    if (this.text) this.finalizeText();
    if (this.onScreen) this.breakLine();
  }

  onTool(event) {
    this.endInline();
    const record = this.tools.get(event.id) || {};
    if (event.args) record.args = event.args;
    const summary = record.summary || toolSummary(event.name, event.args || record.args);
    this.tools.set(event.id, { ...record, name: event.name, status: event.status, summary });

    if (event.status === 'running') {
      this.out.write(`${COLORS.faint(`  ${SIGN.run} ${summary}…`)}\n`);
      return;
    }
    const detail = this.toolDetail(event);
    if (event.status === 'ok') {
      this.out.write(
        `${COLORS.green(`  ${SIGN.ok}`)} ${COLORS.dim(summary)}${detail ? COLORS.faint(` · ${detail}`) : ''}\n`
      );
    } else {
      const firstLine = String(event.output || '')
        .split('\n')
        .find((line) => line.trim() && !line.startsWith('$ '));
      this.out.write(
        `${COLORS.red(`  ${SIGN.fail}`)} ${COLORS.dim(summary)}${
          firstLine ? COLORS.red(` · ${truncate(firstLine, 80)}`) : ''
        }\n`
      );
    }
    if (event.review?.reason) {
      const source = event.review.source === 'auto' ? t('reviewing') : t('approval_op');
      this.out.write(`${COLORS.faint(`     ${source} · ${event.review.reason}`)}\n`);
    }
  }

  toolDetail(event) {
    const output = String(event.output || '');
    if (event.name === 'read_file') return `${output.length} ${t('chars')}`;
    if (event.name === 'run_command') {
      const exit = output.match(/\[exit\] code=(\S+)/);
      if (exit) return `${t('exit_code')} ${exit[1]}`;
      return `${output.split('\n').filter(Boolean).length} ${t('lines')}`;
    }
    if (event.name === 'list_directory') return `${output.split('\n').filter(Boolean).length} ${t('items')}`;
    if (event.name === 'fetch_url') {
      const match = output.match(/^HTTP (\d{3})/);
      return match ? `HTTP ${match[1]}` : '';
    }
    if (event.name === 'install_mcp_server') return 'saved';
    return '';
  }

  finish(event) {
    const hadText = Boolean(this.text.trim());
    this.endReasoning();

    if (event.type === 'error') {
      this.endInline();
      this.out.write(`\n${COLORS.red(`${SIGN.fail} ${t('generation_error')}: ${event.message}`)}\n`);
    } else if (event.type === 'aborted') {
      this.finalizeText();
      this.out.write(`${COLORS.yellow(`${SIGN.bullet} ${t('stopped')}`)}\n`);
    } else {
      this.finalizeText();
      if (!hadText && !this.tools.size && !this.reasoning.trim()) {
        this.out.write(`${COLORS.faint(t('no_content'))}\n`);
      }
    }

    if (event.usage) {
      const usage = event.usage;
      const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? null;
      const output = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? null;
      if (input != null || output != null) {
        this.out.write(`${COLORS.faint(`  ${input ?? '?'} ${t('in_out')} ${output ?? '?'} ${t('out')}`)}\n`);
      }
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resume();
  }
}

module.exports = { StreamRenderer, toolSummary, foldLine, TOOL_KEYS, formatSeconds };
