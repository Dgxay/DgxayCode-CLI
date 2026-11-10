'use strict';

/**
 * export：导出会话（桌面版没有这个能力，CLI 补上）。
 *
 *   dgxay export                把最近一个会话输出到 stdout（Markdown）
 *   dgxay export -o chat.md     写入文件
 *   dgxay export --format json  导出 JSON
 *   dgxay export 2              指定会话序号
 */

const fs = require('fs');
const path = require('path');
const print = require('../cli/print');
const { actionFirst } = require('../cli/args');
const sessions = require('../core/sessions');

const options = [
  { name: 'format', type: 'string', valueName: 'md|json', desc: '输出格式：markdown（默认）/ json' },
  { name: 'output', alias: 'o', type: 'string', valueName: 'file', desc: '写入文件而不是打印' }
];

function toMarkdown(chat) {
  const lines = [];
  const date = new Date(chat.createdAt || Date.now());
  lines.push(`# ${chat.title || '新对话'}`);
  lines.push('');
  lines.push(`> ${date.toLocaleString()} · ${chat.mode === 'work' ? '工作模式' : '对话模式'}${chat.skill ? ` · 技能 ${chat.skill}` : ''}`);
  lines.push('');
  for (const message of chat.messages) {
    if (message.role === 'user') {
      lines.push('## 用户');
      lines.push('');
      lines.push(message.content || '');
      lines.push('');
    } else if (message.role === 'assistant') {
      lines.push('## DgxayCode');
      lines.push('');
      lines.push(message.content || '');
      lines.push('');
      if (message.toolLog?.length) {
        lines.push('<details><summary>工具调用</summary>');
        lines.push('');
        for (const tool of message.toolLog) {
          lines.push(`- \`${tool.name}\` ${tool.ok ? '成功' : '失败'}${tool.review?.reason ? ` · ${tool.review.reason}` : ''}`);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    } else if (message.role === 'terminal') {
      lines.push('## 终端');
      lines.push('');
      lines.push('```');
      lines.push(`$ ${message.command}`);
      lines.push(`${message.output || ''}${message.stderr || ''}`.trimEnd());
      lines.push('```');
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function run({ argv }) {
  const { action, rest, options: opts } = actionFirst(argv, options);
  const ref = action || rest[0] || '';
  const chats = sessions.listChats();
  if (!chats.length) {
    print.warn('还没有可以导出的会话');
    return 1;
  }
  const chat = ref ? sessions.resolveChat(ref, chats) : chats[0];
  if (!chat) {
    print.fail(`找不到会话：${ref}`);
    return 1;
  }
  const format = String(opts.format || 'md').toLowerCase();
  const content =
    format === 'json'
      ? `${JSON.stringify(chat, null, 2)}\n`
      : toMarkdown(chat);

  if (opts.output) {
    const target = path.resolve(opts.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    print.ok(`已导出「${chat.title}」到 ${target}`);
    return 0;
  }
  process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
  return 0;
}

module.exports = {
  name: 'export',
  aliases: ['dump'],
  summary: '导出会话为 Markdown / JSON',
  usage: 'dgxay export [序号|ID] [--format md|json] [-o 文件]',
  options,
  examples: ['dgxay export', 'dgxay export 2 -o chat.md', 'dgxay export -o chats.json --format json'],
  run
};
