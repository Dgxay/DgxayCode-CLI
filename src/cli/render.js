'use strict';

/**
 * 流式渲染：把 agent 事件流翻译成终端输出。
 *
 * 关键约束（来自真实 Windows 控制台的实测）：不能依赖「光标上移 + 清行」来重绘。
 * 很多终端（尤其是某些 Windows 控制台组合）会忽略 `\x1b[nA`，
 * 于是每次重绘都会把整块内容当成新行往下追加，出现「一段一行」的堆积。
 *
 * 因此只使用所有终端都支持的原始能力：`\r` 回到行首、空格覆盖清尾，绝不回退到上面的行。
 *
 * 渲染策略：
 *   - 流式阶段：只在**最后一行**用 \r 实时刷新（纯文本，不解析 Markdown），
 *     用户看到的是一行不断变长的文字；
 *   - 收尾阶段：抹掉这行预览，再用 Markdown 渲染器把整段完整输出一次，
 *     表格 / 代码块 / 标题才能正确对齐，且只发生一次。
 */

const { COLORS, SIGN, displayWidth, truncate, termWidth, renderMarkdown } = require('./ansi');

const TOOL_TITLES = {
  list_directory: '列出目录',
  read_file: '读取文件',
  write_file: '写入文件',
  create_directory: '创建目录',
  delete_path: '删除',
  run_command: '执行命令',
  fetch_url: '访问网络',
  install_mcp_server: '安装 MCP'
};

function toolSummary(name, argsRaw) {
  let args = {};
  try {
    args = argsRaw ? JSON.parse(argsRaw) : {};
  } catch {
    args = {};
  }
  const title = TOOL_TITLES[name] || name;
  const target = args.path || args.url || args.command || args.name || '';
  return target
    ? `${title} ${truncate(String(target).replace(/\s+/g, ' '), Math.max(20, termWidth() - 24))}`
    : title;
}

/** 把一行过长的文本按显示宽度折开（流式预览用，纯文本） */
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

class StreamRenderer {
  constructor(options = {}) {
    this.out = options.output || process.stdout;
    this.editor = options.editor || null;
    // 只有真正的交互终端才做「行内实时刷新」；管道输出保持纯净
    const tty = Boolean(this.out.isTTY);
    this.live = options.redraw !== undefined ? Boolean(options.redraw) : tty;
    this.width = Math.max(20, (options.width || termWidth()) - 1);
    this.reset();
  }

  reset() {
    this.started = false;
    /** 已收到的完整正文 */
    this.text = '';
    /** 当前物理行屏幕上的内容（用于 \r 覆盖清尾） */
    this.onScreen = '';
    /** 收到的换行数，用来决定收尾时是否需要重排 */
    this.newlines = 0;
    this.tools = new Map();
    this.reasoning = '';
    this.reasoningStart = 0;
    this.reasoningMs = 0;
    this.suspended = false;
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

  /* ------------------------------ 行内刷新 ------------------------------ */

  /**
   * 把「当前物理行」替换成 text：\r 回到行首，写出 text，再用空格擦掉多余的尾部。
   * 全程不换行、不上移，因此无论终端是否支持光标控制都不会堆积。
   */
  repaintLine(text) {
    const visible = displayWidth(text);
    const previous = displayWidth(this.onScreen);
    const pad = Math.max(0, previous - visible);
    this.out.write(`\r${text}${' '.repeat(pad)}`);
    if (pad) this.out.write(`\b`.repeat(pad));
    this.onScreen = text;
  }

  /** 结束当前物理行 */
  breakLine() {
    this.out.write('\n');
    this.onScreen = '';
  }

  /* ------------------------------ 正文 ------------------------------ */

  ensureHeader() {
    if (this.started) return;
    this.started = true;
    this.suspend();
    this.out.write(`\n${COLORS.accent('•')} ${COLORS.bold('DgxayCode')}\n`);
    this.onScreen = '';
  }

  /** 流式阶段：交互终端才刷新预览行；管道模式下只累积，收尾时一次性输出 */
  writeText(text) {
    this.ensureHeader();
    this.text += text;
    this.newlines += (text.match(/\n/g) || []).length;
    if (!this.live) return;

    const lines = this.text.split('\n');
    const tail = lines[lines.length - 1];
    const folded = foldLine(tail, this.width);
    // 只保留最后一段可视宽度内的一行，避免预览超出屏幕后折行导致覆盖错位
    const preview = folded[folded.length - 1];
    this.repaintLine(preview);
  }

  /**
   * 收尾：抹掉预览行，按 Markdown 完整输出正文（只发生一次）。
   */
  finalizeText() {
    if (!this.text) {
      this.onScreen = '';
      return;
    }
    // 预览行 → 清空（仅交互终端才有预览行）
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
      case 'delta':
        if (!event.text) return;
        this.writeText(event.text);
        return;
      case 'reasoning':
        if (!event.text) return;
        if (!this.reasoningStart) this.reasoningStart = Date.now();
        this.reasoning += event.text;
        this.ensureHeader();
        return;
      case 'tool':
        this.onTool(event);
        return;
      case 'review-start':
        this.endInline();
        this.out.write(`${COLORS.faint(`  ${SIGN.run} 正在自动审查 ${event.name}…`)}\n`);
        return;
      case 'review':
        this.endInline();
        if (event.decision === 'allow') {
          this.out.write(
            `${COLORS.green(`  ${SIGN.ok}`)} ${COLORS.green('自动审查放行')} ${COLORS.faint(
              `${event.reviewer || ''} · ${event.reason || ''}`
            )}\n`
          );
        } else {
          this.out.write(
            `${COLORS.yellow(`  ${SIGN.run}`)} ${COLORS.yellow('自动审查判定可疑，转交确认')} ${COLORS.faint(
              event.reason || ''
            )}\n`
          );
        }
        return;
      case 'waiting':
        this.endInline();
        this.out.write(`${COLORS.faint(`  ${SIGN.run} 等待用户确认 ${event.name}…`)}\n`);
        return;
      case 'file':
        this.endInline();
        this.out.write(
          `${COLORS.green(`  ${SIGN.ok}`)} ${COLORS.dim(
            event.action === 'deleted' ? '删除' : event.action === 'updated' ? '更新' : '创建'
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

  /** 正文中途插入了其他内容（工具调用、审查提示等）：先把已有正文按 Markdown 落地 */
  endInline() {
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
      this.out.write(
        `${COLORS.faint(`     ${event.review.source === 'auto' ? '自动审查' : '确认'} · ${event.review.reason}`)}\n`
      );
    }
  }

  toolDetail(event) {
    const output = String(event.output || '');
    if (event.name === 'read_file') return `${output.length} 字符`;
    if (event.name === 'run_command') {
      const exit = output.match(/\[exit\] code=(\S+)/);
      if (exit) return `退出码 ${exit[1]}`;
      return `${output.split('\n').filter(Boolean).length} 行输出`;
    }
    if (event.name === 'list_directory') return `${output.split('\n').filter(Boolean).length} 项`;
    if (event.name === 'fetch_url') {
      const match = output.match(/^HTTP (\d{3})/);
      return match ? `HTTP ${match[1]}` : '';
    }
    if (event.name === 'install_mcp_server') return '已保存配置';
    return '';
  }

  finish(event) {
    if (this.reasoningStart && !this.reasoningMs) this.reasoningMs = Date.now() - this.reasoningStart;
    const hadText = Boolean(this.text.trim());

    if (event.type === 'error') {
      this.endInline();
      this.out.write(`\n${COLORS.red(`${SIGN.fail} 出错了：${event.message}`)}\n`);
    } else if (event.type === 'aborted') {
      this.finalizeText();
      this.out.write(`${COLORS.yellow(`${SIGN.bullet} 已停止生成`)}\n`);
    } else {
      this.finalizeText();
      if (!hadText && !this.tools.size && !this.reasoning.trim()) {
        this.out.write(`${COLORS.faint('（模型没有返回内容）')}\n`);
      }
    }

    if (this.reasoning.trim()) {
      const ms = this.reasoningMs || 0;
      const seconds = ms > 0 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) : '0';
      this.out.write(`${COLORS.faint(`  ⌁ 已思考 ${seconds}s · ${this.reasoning.length} 字符`)}\n`);
    }
    if (event.usage) {
      const usage = event.usage;
      const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? null;
      const output = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? null;
      if (input != null || output != null) {
        this.out.write(`${COLORS.faint(`  用量 ${input ?? '?'} in / ${output ?? '?'} out`)}\n`);
      }
    }
    this.resume();
  }
}

module.exports = { StreamRenderer, toolSummary, TOOL_TITLES, foldLine };
