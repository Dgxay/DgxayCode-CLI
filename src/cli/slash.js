'use strict';

/**
 * 交互模式里的斜杠命令（对应桌面版输入框的 / 菜单）。
 *
 * 与桌面版的关系：
 *   桌面版只有 /压缩 与 /技能；CLI 额外提供会话、模型、权限、MCP 等
 *   「原本在界面按钮上」的操作，保证去掉 UI 后功能不丢。
 */

const SLASH_COMMANDS = [
  { name: '/help', desc: '查看所有命令', usage: '/help' },
  { name: '/new', desc: '开始新对话', usage: '/new' },
  { name: '/list', desc: '列出历史对话', usage: '/list' },
  { name: '/resume', desc: '恢复历史对话', usage: '/resume <序号|ID>' },
  { name: '/delete', desc: '删除一段对话', usage: '/delete <序号|ID>' },
  { name: '/rename', desc: '重命名当前对话', usage: '/rename <标题>' },
  { name: '/compress', desc: '压缩上下文（有损，不可撤销）', usage: '/compress', aliases: ['/压缩'] },
  { name: '/skill', desc: '列出或启用技能', usage: '/skill [名称] [提示词]', aliases: ['/技能'] },
  { name: '/model', desc: '查看或切换模型', usage: '/model [序号|ID]' },
  { name: '/provider', desc: '查看或切换供应商', usage: '/provider [序号|名称]' },
  { name: '/mode', desc: '切换对话 / 工作模式', usage: '/mode [chat|work]' },
  { name: '/permission', desc: '切换权限档位', usage: '/permission [none|normal|auto|full]' },
  { name: '/cd', desc: '切换工作空间', usage: '/cd <目录>' },
  { name: '/ls', desc: '查看工作空间文件', usage: '/ls [目录]' },
  { name: '/pwd', desc: '显示当前工作空间', usage: '/pwd' },
  { name: '/term', desc: '执行终端命令（不进模型上下文时用 ! 前缀）', usage: '/term <命令>' },
  { name: '/context', desc: '查看上下文用量', usage: '/context' },
  { name: '/mcp', desc: '管理 MCP：list/start/stop/logs/add/rm', usage: '/mcp [子命令]' },
  { name: '/theme', desc: '开关颜色输出', usage: '/theme [on|off]' },
  { name: '/clear', desc: '清屏（不删除会话）', usage: '/clear' },
  { name: '/exit', desc: '退出', usage: '/exit', aliases: ['/quit'] }
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
 * 行编辑器的补全器：只在输入以 / 开头且光标在首行时弹出。
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
    title: '斜杠命令',
    hint: '↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭',
    items
  };
}

module.exports = { SLASH_COMMANDS, findCommand, completer };
