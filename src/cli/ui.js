'use strict';

/**
 * 上下文用量（对应桌面版的上下文圆环）。
 */

const { estimateChatTokens, contextLimit, formatTokens } = require('../core/sessions');
const { COLORS, ring, truncate, displayWidth, termWidth } = require('./ansi');

function contextInfo(chat, model) {
  const used = estimateChatTokens(chat);
  const limit = contextLimit(model);
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const messageCount = (chat?.messages || []).filter((msg) => msg.role !== 'terminal').length;
  return { used, limit, ratio, messageCount, model, skill: chat?.skill || '' };
}

/** 输入框下方的上下文环（单行） */
function ringLine(info) {
  const percent = Math.round(info.ratio * 100);
  return `${ring(info.ratio)} ${COLORS.faint(`${formatTokens(info.used)}/${formatTokens(info.limit)} · ${percent}%`)}`;
}

/** /context 命令的详细输出 */
function contextReport(info) {
  const lines = [];
  const percent = (info.ratio * 100).toFixed(info.ratio < 0.1 ? 1 : 0);
  lines.push(`${COLORS.accent('上下文')} ${COLORS.bold(`${percent}%`)} ${COLORS.faint(
    `${formatTokens(info.used)} / ${formatTokens(info.limit)}`
  )}`);
  const width = Math.max(10, Math.min(40, termWidth() - 12));
  const filled = Math.round(info.ratio * width);
  lines.push(`${COLORS.accent('█'.repeat(filled))}${COLORS.faint('░'.repeat(Math.max(0, width - filled)))}`);
  lines.push('');
  const rows = [
    ['对话消息', String(info.messageCount)],
    ['上下文上限', formatTokens(info.limit)],
    ['剩余可用', formatTokens(Math.max(0, info.limit - info.used))],
    ['当前模型', info.model?.name || '未选择'],
    ['供应商', info.model?.providerName || ''],
    ['技能', info.skill || '无']
  ];
  const labelWidth = Math.max(...rows.map(([label]) => displayWidth(label)));
  for (const [label, value] of rows) {
    lines.push(`  ${COLORS.faint(truncate(label, 12).padEnd(labelWidth))}  ${value}`);
  }
  lines.push('');
  lines.push(COLORS.faint('按字符启发式估算，实际 token 以模型 usage 为准；接近上限时用 /compress 保留重要上下文。'));
  return lines.join('\n');
}

module.exports = { contextInfo, ringLine, contextReport };
