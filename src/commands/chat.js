'use strict';

/**
 * chat：会话管理与在新会话中提问。
 *
 *   dgxay chat new               新建会话
 *   dgxay chat list              列出历史会话
 *   dgxay chat show <序号|ID>    查看某个会话
 *   dgxay chat resume <序号|ID>  进入交互模式并恢复该会话
 *   dgxay chat rm <序号|ID>      删除会话
 *   dgxay chat rename <序号|ID> <标题>
 *   dgxay chat clear             清空全部会话
 *   dgxay chat "问题"            在最近会话上继续提问
 */

const fs = require('fs');
const print = require('../cli/print');
const { parseArgs, actionFirst } = require('../cli/args');
const { COLORS, renderMarkdown, termWidth } = require('../cli/ansi');
const sessions = require('../core/sessions');

const options = [
  { name: 'print', alias: 'p', type: 'string', valueName: 'text', desc: 'Ask directly (same as dgxay run)' },
  { name: 'mode', alias: 'm', type: 'string', valueName: 'mode', desc: 'chat / work' },
  { name: 'permission', type: 'string', valueName: 'level', desc: 'none / normal / auto / full' },
  { name: 'workspace', alias: 'C', type: 'string', valueName: 'dir', desc: 'Workspace directory' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: 'Auto-approve permission requests' },
  { name: 'yes-all', type: 'boolean', desc: 'Skip confirmation when clearing conversations' }
];

function relativeTime(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} h ago`;
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function listChats() {
  const chats = sessions.listChats();
  print.blank();
  if (!chats.length) {
    print.hint('No saved conversations yet');
    return 0;
  }
  print.heading(`Conversation history (${chats.length}, at most ${sessions.MAX_CHATS} kept)`);
  const rows = chats.map((chat, index) => {
    const messages = chat.messages.filter((m) => m.role !== 'terminal');
    const last = messages[messages.length - 1];
    return [
      String(index + 1),
      chat.title || 'New conversation',
      String(messages.length),
      relativeTime(chat.updatedAt),
      chat.mode === 'work' ? 'work' : 'chat',
      chat.skill || '',
      last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 40) : ''
    ];
  });
  print.table(
    [
      { title: '#', max: 3 },
      { title: 'Title', max: 30 },
      { title: 'Messages', max: 4 },
      { title: 'Updated', max: 10 },
      { title: 'Mode', max: 4 },
      { title: 'Skill', max: 12 },
      { title: 'Last message', max: 40 }
    ],
    rows
  );
  print.blank();
  print.hint('dgxay chat resume 1        resume conversation 1');
  print.hint('dgxay -r 1                 resume and enter interactive mode');
  print.hint('dgxay chat show 1          view contents only');
  print.blank();
  return 0;
}

function showChat(ref) {
  const chat = sessions.resolveChat(ref);
  if (!chat) {
    print.fail(`Conversation not found: ${ref}`);
    return 1;
  }
  print.blank();
  print.write(`${COLORS.bold(chat.title)} ${COLORS.faint(`${chat.id} · ${relativeTime(chat.updatedAt)}`)}`);
  for (const message of chat.messages) {
    if (message.role === 'user') {
      print.write(`\n${COLORS.accent('▍You')}`);
      print.write(message.content || '');
    } else if (message.role === 'assistant') {
      print.write(`\n${COLORS.accent('▍DgxayCode')}`);
      process.stdout.write(renderMarkdown(message.content || '', { width: termWidth() }));
      if (message.error) print.write(COLORS.red(message.error));
      if (message.tools?.length) {
        for (const tool of message.tools) {
          print.write(COLORS.faint(`  · ${tool.name} ${tool.ok ? 'ok' : 'failed'}`));
        }
      }
    } else if (message.role === 'terminal') {
      print.write(`\n${COLORS.faint(`▍Terminal $ ${message.command}`)}`);
      const output = `${message.output || ''}${message.stderr ? `\n${message.stderr}` : ''}`;
      print.write(output.slice(0, 4000));
      print.write(COLORS.faint(`  exit=${message.exitCode ?? '?'}`));
    }
  }
  print.blank();
  return 0;
}

async function run({ argv, runtime }) {
  const { action: rawAction, rest, options: opts } = actionFirst(argv, options);
  const action = rawAction || 'list';

  switch (action) {
    case 'list':
    case 'ls':
      return listChats();

    case 'show':
    case 'view': {
      if (!rest[0]) throw Object.assign(new Error('Usage: dgxay chat show <index|id>'), { userError: true });
      return showChat(rest[0]);
    }

    case 'new': {
      print.ok(opts.print ? 'New conversation started (single question, not saved to history)' : 'A conversation is created automatically when interactive mode starts');
      return 0;
    }

    case 'resume': {
      if (!rest[0]) throw Object.assign(new Error('Usage: dgxay chat resume <index|id>'), { userError: true });
      const chat = sessions.resolveChat(rest[0]);
      if (!chat) {
        print.fail(`Conversation not found: ${rest[0]}`);
        return 1;
      }
      const repl = require('../cli/repl');
      return repl.start({ ...runtime, resume: chat.id, single: false });
    }

    case 'rm':
    case 'delete': {
      if (!rest[0]) throw Object.assign(new Error('Usage: dgxay chat rm <index|id>'), { userError: true });
      const chat = sessions.resolveChat(rest[0]);
      if (!chat) {
        print.fail(`Conversation not found: ${rest[0]}`);
        return 1;
      }
      sessions.deleteChat(chat.id);
      print.ok(`Deleted "${chat.title}"`);
      return 0;
    }

    case 'rename': {
      const ref = rest[0];
      const title = rest.slice(1).join(' ').trim();
      if (!ref || !title) throw Object.assign(new Error('Usage: dgxay chat rename <index|id> <new title>'), { userError: true });
      const chat = sessions.resolveChat(ref);
      if (!chat) {
        print.fail(`Conversation not found: ${ref}`);
        return 1;
      }
      chat.title = title;
      chat.updatedAt = Date.now();
      sessions.saveChat(chat);
      print.ok(`Renamed to "${title}"`);
      return 0;
    }

    case 'clear': {
      if (!opts.yesAll && process.stdin.isTTY) {
        const { confirm } = require('../services/input');
        const ok = await confirm('Clear all conversation history? (cannot be undone)', false);
        if (!ok) {
          print.hint('Cancelled');
          return 1;
        }
      }
      sessions.clearChats();
      print.ok('All conversations cleared');
      return 0;
    }

    default: {
      // 非子命令：当作提示词，在最近会话上继续提问
      const prompt = positionals.join(' ').trim();
      const repl = require('../cli/repl');
      return repl.start({ ...runtime, initialPrompt: prompt, single: true, continueLast: true });
    }
  }
}

module.exports = {
  name: 'chat',
  aliases: ['c'],
  summary: 'Manage conversations: list, show, resume, delete',
  usage: 'dgxay chat <list|show|resume|rm|rename|clear>',
  options,
  subcommands: [
    ['list', 'List conversation history'],
    ['show <index|id>', 'View conversation contents'],
    ['resume <index|id>', 'Resume in interactive mode'],
    ['rm <index|id>', 'Delete a conversation'],
    ['rename <index|id> <title>', 'Rename a conversation'],
    ['clear', 'Clear all conversations']
  ],
  examples: ['dgxay chat list', 'dgxay chat resume 1', 'dgxay chat rm 2', 'dgxay chat show 1'],
  run
};
