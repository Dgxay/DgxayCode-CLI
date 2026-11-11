'use strict';

/**
 * 交互模式里的斜杠命令。
 *
 * 桌面版只有 /压缩 与 /技能；CLI 额外提供会话、模型、权限、MCP 等
 * 「原本在界面按钮上」的操作，保证去掉 UI 后功能不丢。
 */

const { t } = require('./i18n');

const SLASH_COMMANDS = [
  { name: '/help', desc: 'Show all commands', usage: '/help' },
  { name: '/new', desc: 'Start a new conversation', usage: '/new' },
  { name: '/list', desc: 'List saved conversations', usage: '/list' },
  { name: '/resume', desc: 'Restore a conversation', usage: '/resume <n|id>' },
  { name: '/delete', desc: 'Delete a conversation', usage: '/delete <n|id>' },
  { name: '/rename', desc: 'Rename current conversation', usage: '/rename <title>' },
  { name: '/compress', desc: 'Compress context (lossy)', usage: '/compress', aliases: ['/压缩'] },
  { name: '/skill', desc: 'List or enable skills', usage: '/skill [name] [prompt]', aliases: ['/技能'] },
  { name: '/model', desc: 'Show or switch model', usage: '/model [n|id]' },
  { name: '/provider', desc: 'Show or switch provider', usage: '/provider [n|name]' },
  { name: '/mode', desc: 'Switch chat / work mode', usage: '/mode [chat|work]' },
  { name: '/permission', desc: 'Switch permission level', usage: '/permission [level]' },
  { name: '/cd', desc: 'Change workspace', usage: '/cd <dir>' },
  { name: '/ls', desc: 'List workspace files', usage: '/ls [dir]' },
  { name: '/pwd', desc: 'Show current workspace', usage: '/pwd' },
  { name: '/term', desc: 'Run a shell command', usage: '/term <command>' },
  { name: '/context', desc: 'Show context usage', usage: '/context' },
  { name: '/mcp', desc: 'Manage MCP servers', usage: '/mcp [subcommand]' },
  { name: '/theme', desc: 'Toggle color output', usage: '/theme [on|off]' },
  { name: '/clear', desc: 'Clear the screen', usage: '/clear' },
  { name: '/exit', desc: 'Exit', usage: '/exit', aliases: ['/quit', '/q'] }
];

function findCommand(text) {
  const token = String(text || '').trim().split(/\s+/)[0].toLowerCase();
  if (!token) return null;
  return (
    SLASH_COMMANDS.find((cmd) => cmd.name === token) ||
    SLASH_COMMANDS.find((cmd) => (cmd.aliases || []).includes(token)) ||
    null
  );
}

/**
 * 行编辑器的补全器：输入以 / 开头且尚未输入参数时给出候选。
 * 返回 { items: [{ label, hint, apply }], title, hint }
 */
function completer(value, cursor) {
  if (!value || !value.startsWith('/')) return null;
  if (value.includes('\n')) return null;
  const before = value.slice(0, cursor);
  if (before.includes(' ')) return null;
  const query = before.slice(1).toLowerCase();
  const items = SLASH_COMMANDS.filter(
    (cmd) =>
      !query ||
      cmd.name.slice(1).toLowerCase().startsWith(query) ||
      (cmd.aliases || []).some((alias) => alias.slice(1).toLowerCase().startsWith(query))
  ).map((cmd) => ({
    label: cmd.name,
    hint: cmd.desc,
    apply: `${cmd.name} `,
    command: cmd
  }));
  if (!items.length) return null;
  return {
    title: t('menu_title'),
    hint: t('menu_hint'),
    items
  };
}

module.exports = { SLASH_COMMANDS, findCommand, completer };
