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
  { name: 'format', type: 'string', valueName: 'md|json', desc: 'Output format: markdown (default) / json' },
  { name: 'output', alias: 'o', type: 'string', valueName: 'file', desc: 'Write to a file instead of printing' }
];

function toMarkdown(chat) {
  const lines = [];
  const date = new Date(chat.createdAt || Date.now());
  lines.push(`# ${chat.title || 'New conversation'}`);
  lines.push('');
  lines.push(`> ${date.toLocaleString()} · ${chat.mode === 'work' ? 'Work mode' : 'Chat mode'}${chat.skill ? ` · Skill ${chat.skill}` : ''}`);
  lines.push('');
  for (const message of chat.messages) {
    if (message.role === 'user') {
      lines.push('## User');
      lines.push('');
      lines.push(message.content || '');
      lines.push('');
    } else if (message.role === 'assistant') {
      lines.push('## DgxayCode');
      lines.push('');
      lines.push(message.content || '');
      lines.push('');
      if (message.toolLog?.length) {
        lines.push('<details><summary>Tool calls</summary>');
        lines.push('');
        for (const tool of message.toolLog) {
          lines.push(`- \`${tool.name}\` ${tool.ok ? 'ok' : 'failed'}${tool.review?.reason ? ` · ${tool.review.reason}` : ''}`);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    } else if (message.role === 'terminal') {
      lines.push('## Terminal');
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
    print.warn('No conversation to export yet');
    return 1;
  }
  const chat = ref ? sessions.resolveChat(ref, chats) : chats[0];
  if (!chat) {
    print.fail(`Conversation not found: ${ref}`);
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
    print.ok(`Exported "${chat.title}" to ${target}`);
    return 0;
  }
  process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
  return 0;
}

module.exports = {
  name: 'export',
  aliases: ['dump'],
  summary: 'Export a conversation as Markdown / JSON',
  usage: 'dgxay export [n|id] [--format md|json] [-o file]',
  options,
  examples: ['dgxay export', 'dgxay export 2 -o chat.md', 'dgxay export -o chats.json --format json'],
  run
};
