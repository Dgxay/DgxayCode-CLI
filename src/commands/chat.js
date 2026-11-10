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
  { name: 'print', alias: 'p', type: 'string', valueName: 'text', desc: '直接提问（等同 dgxay run）' },
  { name: 'mode', alias: 'm', type: 'string', valueName: 'mode', desc: 'chat / work' },
  { name: 'permission', type: 'string', valueName: 'level', desc: 'none / normal / auto / full' },
  { name: 'workspace', alias: 'C', type: 'string', valueName: 'dir', desc: '工作空间目录' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: '自动同意授权请求' },
  { name: 'yes-all', type: 'boolean', desc: '清空会话时跳过确认' }
];

function relativeTime(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  const date = new Date(ts);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function listChats() {
  const chats = sessions.listChats();
  print.blank();
  if (!chats.length) {
    print.hint('还没有保存的会话');
    return 0;
  }
  print.heading(`历史会话（${chats.length}，最多保留 ${sessions.MAX_CHATS} 段）`);
  const rows = chats.map((chat, index) => {
    const messages = chat.messages.filter((m) => m.role !== 'terminal');
    const last = messages[messages.length - 1];
    return [
      String(index + 1),
      chat.title || '新对话',
      String(messages.length),
      relativeTime(chat.updatedAt),
      chat.mode === 'work' ? '工作' : '对话',
      chat.skill || '',
      last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 40) : ''
    ];
  });
  print.table(
    [
      { title: '#', max: 3 },
      { title: '标题', max: 30 },
      { title: '消息', max: 4 },
      { title: '更新时间', max: 10 },
      { title: '模式', max: 4 },
      { title: '技能', max: 12 },
      { title: '最后内容', max: 40 }
    ],
    rows
  );
  print.blank();
  print.hint('dgxay chat resume 1        恢复第 1 个会话');
  print.hint('dgxay -r 1                 直接恢复并进入交互模式');
  print.hint('dgxay chat show 1          只查看内容');
  print.blank();
  return 0;
}

function showChat(ref) {
  const chat = sessions.resolveChat(ref);
  if (!chat) {
    print.fail(`找不到会话：${ref}`);
    return 1;
  }
  print.blank();
  print.write(`${COLORS.bold(chat.title)} ${COLORS.faint(`${chat.id} · ${relativeTime(chat.updatedAt)}`)}`);
  for (const message of chat.messages) {
    if (message.role === 'user') {
      print.write(`\n${COLORS.accent('▍你')}`);
      print.write(message.content || '');
    } else if (message.role === 'assistant') {
      print.write(`\n${COLORS.accent('▍DgxayCode')}`);
      process.stdout.write(renderMarkdown(message.content || '', { width: termWidth() }));
      if (message.error) print.write(COLORS.red(message.error));
      if (message.tools?.length) {
        for (const tool of message.tools) {
          print.write(COLORS.faint(`  · ${tool.name} ${tool.ok ? '成功' : '失败'}`));
        }
      }
    } else if (message.role === 'terminal') {
      print.write(`\n${COLORS.faint(`▍终端 $ ${message.command}`)}`);
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
      if (!rest[0]) throw Object.assign(new Error('用法：dgxay chat show <序号|ID>'), { userError: true });
      return showChat(rest[0]);
    }

    case 'new': {
      print.ok(opts.print ? '新会话已建立（单次提问，不会保存到历史）' : '进入交互模式后将自动创建会话');
      return 0;
    }

    case 'resume': {
      if (!rest[0]) throw Object.assign(new Error('用法：dgxay chat resume <序号|ID>'), { userError: true });
      const chat = sessions.resolveChat(rest[0]);
      if (!chat) {
        print.fail(`找不到会话：${rest[0]}`);
        return 1;
      }
      const repl = require('../cli/repl');
      return repl.start({ ...runtime, resume: chat.id, single: false });
    }

    case 'rm':
    case 'delete': {
      if (!rest[0]) throw Object.assign(new Error('用法：dgxay chat rm <序号|ID>'), { userError: true });
      const chat = sessions.resolveChat(rest[0]);
      if (!chat) {
        print.fail(`找不到会话：${rest[0]}`);
        return 1;
      }
      sessions.deleteChat(chat.id);
      print.ok(`已删除「${chat.title}」`);
      return 0;
    }

    case 'rename': {
      const ref = rest[0];
      const title = rest.slice(1).join(' ').trim();
      if (!ref || !title) throw Object.assign(new Error('用法：dgxay chat rename <序号|ID> <新标题>'), { userError: true });
      const chat = sessions.resolveChat(ref);
      if (!chat) {
        print.fail(`找不到会话：${ref}`);
        return 1;
      }
      chat.title = title;
      chat.updatedAt = Date.now();
      sessions.saveChat(chat);
      print.ok(`已重命名为「${title}」`);
      return 0;
    }

    case 'clear': {
      if (!opts.yesAll && process.stdin.isTTY) {
        const { confirm } = require('../services/input');
        const ok = await confirm('清空全部会话记录？（不可恢复）', false);
        if (!ok) {
          print.hint('已取消');
          return 1;
        }
      }
      sessions.clearChats();
      print.ok('全部会话已清空');
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
  summary: '会话管理：列表、查看、恢复、删除',
  usage: 'dgxay chat <list|show|resume|rm|rename|clear>',
  options,
  subcommands: [
    ['list', '列出历史会话'],
    ['show <序号|ID>', '查看会话内容'],
    ['resume <序号|ID>', '进入交互模式并恢复'],
    ['rm <序号|ID>', '删除会话'],
    ['rename <序号|ID> <标题>', '重命名会话'],
    ['clear', '清空全部会话']
  ],
  examples: ['dgxay chat list', 'dgxay chat resume 1', 'dgxay chat rm 2', 'dgxay chat show 1'],
  run
};
