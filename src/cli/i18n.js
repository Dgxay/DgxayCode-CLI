'use strict';

/**
 * 界面文案：默认英文，可用 DGXAY_LANG=zh 切回中文。
 *
 * 只负责「界面」文字；AI 回复语言由系统提示决定（见 core/prompt.js）。
 */

const EN = {
  // 启动 / 横幅
  tagline: 'multi-protocol AI coding assistant',
  hint_start: 'Type / for commands · ! for shell · ↑ history · Ctrl+C to interrupt · Ctrl+D to exit',

  // 状态行
  status_model: 'model',
  status_workspace: 'workspace',
  status_permission: 'permission',
  status_mode: 'mode',
  mode_chat: 'chat',
  mode_work: 'work',

  // 权限
  perm_none: 'no permission',
  perm_normal: 'normal',
  perm_auto: 'auto review',
  perm_full: 'full access',

  // 对话
  you: 'You',
  assistant: 'DgxayCode',
  thinking: 'Thinking',
  thought_for: 'Thought for',
  thinking_now: 'Thinking…',
  tokens: 'tokens',
  in_out: 'in /',
  out: 'out',
  no_content: '(the model returned nothing)',
  generation_error: 'Error',
  stopped: 'Stopped',
  interrupted: 'Interrupting…',
  waiting_confirm: 'waiting for your confirmation',
  reviewing: 'auto-reviewing',
  review_allow: 'auto-review allowed',
  review_suspect: 'auto-review flagged this, asking you',
  empty_input: 'Nothing to send',

  // 授权
  approval_title: 'Permission required',
  approval_tool: 'AI wants to run a tool',
  approval_terminal: 'AI wants to run a shell command',
  approval_op: 'operation',
  approval_ask: 'Allow this?',
  approval_yes: '[y] yes',
  approval_no: '[n] no',
  approval_allowed: 'allowed',
  approval_denied: 'denied',
  approval_timeout: 'timed out',
  approval_noninteractive: 'not an interactive terminal, denied automatically',

  // 输入框
  box_placeholder: 'Ask anything…',
  box_hint: 'Enter to send · \\ to continue · Tab to complete · ↑ history',

  // 斜杠命令菜单
  menu_title: 'Commands',
  menu_hint: '↑↓ select · Tab complete · Enter run · Esc close',

  // 文件 / 工具
  tool_list: 'List',
  tool_read: 'Read',
  tool_write: 'Write',
  tool_mkdir: 'Create dir',
  tool_delete: 'Delete',
  tool_command: 'Run',
  tool_fetch: 'Fetch',
  tool_mcp: 'Install MCP',
  file_created: 'created',
  file_updated: 'updated',
  file_deleted: 'deleted',
  chars: 'chars',
  lines: 'lines',
  items: 'items',
  exit_code: 'exit code',
  no_output: 'no output',

  // 斜杠命令输出
  cmd_unknown: 'Unknown command',
  cmd_help_hint: 'Type /help to list all commands',
  new_chat: 'Started a new conversation',
  restored: 'Restored',
  messages: 'messages',
  deleted: 'Deleted',
  renamed: 'Renamed to',
  no_chats: 'No saved conversations yet',
  compressed: 'Context compressed',
  compress_failed: 'Compression failed',
  compress_running: 'Compressing context…',
  compress_nothing: 'Nothing to compress in this conversation',
  wait_current: 'Please wait for the current reply to finish',
  no_model: 'No model configured. Run dgxay config init',
  model_switched: 'Switched to',
  provider_switched: 'Switched to',
  skill_enabled: 'Skill enabled for this conversation',
  skill_none: 'No skills installed. Put a name.md or <dir>/SKILL.md into ~/.dcb/skills',
  skill_not_found: 'Skill not found',
  skills_off: 'Skill disabled',
  perms_title: 'Permissions',
  perm_set: 'Permission set to',
  perm_auto_unavailable: 'Auto review unavailable: no review model configured',
  perm_full_warning: 'Full access lets the AI run any command and write any file without asking',
  mode_set: 'Mode set to',
  workspace_set: 'Workspace',
  dir_not_found: 'Directory not found',
  not_a_dir: 'Not a directory',
  no_workspace: 'no workspace selected',
  context_title: 'Context',
  used: 'used',
  remaining: 'remaining',
  context_note: 'Estimated from character count; real usage is reported by the model.',
  mcp_title: 'MCP servers',
  mcp_none: 'No MCP servers. Add one with dgxay mcp add',
  mcp_unknown: 'Unknown /mcp action',
  bye: 'Bye. Run dgxay -c to continue the last conversation.',
  cancelled: 'Cancelled',
  session_not_found: 'Conversation not found',
  delete_confirm: 'Delete this conversation?',
  terminal_running: 'A command is already running',
  command_empty: 'Enter a command first',
  perm_denied_terminal: 'No permission to run shell commands',
  model_list_title: 'Models',
  provider_list_title: 'Providers',
  current: 'current',

  // 键盘提示
  key_hint_and: 'and',


  // 错误
  err_title: 'Error',
  err_network: 'Network error',
  err_unauthorized: 'Unauthorized: check your API key or reconnect the account'
};

const ZH = {
  tagline: '多协议 AI 编码助手',
  hint_start: '输入 / 查看命令 · ! 执行终端 · ↑ 历史 · Ctrl+C 中断 · Ctrl+D 退出',
  status_model: '模型',
  status_workspace: '工作空间',
  status_permission: '权限',
  status_mode: '模式',
  mode_chat: '对话',
  mode_work: '工作',
  perm_none: '无权限',
  perm_normal: '普通权限',
  perm_auto: '自动审查',
  perm_full: '完全权限',
  you: '你',
  assistant: 'DgxayCode',
  thinking: '思考',
  thought_for: '已思考',
  thinking_now: '思考中…',
  tokens: 'tokens',
  in_out: 'in /',
  out: 'out',
  no_content: '（模型没有返回内容）',
  generation_error: '出错了',
  stopped: '已停止',
  interrupted: '正在中断…',
  waiting_confirm: '等待确认',
  reviewing: '正在自动审查',
  review_allow: '自动审查放行',
  review_suspect: '自动审查判定可疑，转交确认',
  empty_input: '没有可发送的内容',
  approval_title: '需要授权',
  approval_tool: 'AI 请求执行操作',
  approval_terminal: 'AI 请求执行终端命令',
  approval_op: '操作',
  approval_ask: '允许执行吗？',
  approval_yes: '[y] 允许',
  approval_no: '[n] 拒绝',
  approval_allowed: '允许',
  approval_denied: '已拒绝',
  approval_timeout: '等待超时，已拒绝',
  approval_noninteractive: '当前不是交互终端，已自动拒绝',
  box_placeholder: '问点什么…',
  box_hint: 'Enter 发送 · \\ 续行 · Tab 补全 · ↑ 历史',
  menu_title: '斜杠命令',
  menu_hint: '↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭',
  tool_list: '列出目录',
  tool_read: '读取文件',
  tool_write: '写入文件',
  tool_mkdir: '创建目录',
  tool_delete: '删除',
  tool_command: '执行命令',
  tool_fetch: '访问网络',
  tool_mcp: '安装 MCP',
  file_created: '创建',
  file_updated: '更新',
  file_deleted: '删除',
  chars: '字符',
  lines: '行',
  items: '项',
  exit_code: '退出码',
  no_output: '无输出',
  cmd_unknown: '未知命令',
  cmd_help_hint: '输入 /help 查看全部命令',
  new_chat: '已开始新对话',
  restored: '已恢复',
  messages: '条消息',
  deleted: '已删除',
  renamed: '已重命名为',
  no_chats: '还没有历史对话',
  compressed: '上下文已压缩',
  compress_failed: '压缩失败',
  compress_running: '正在压缩上下文…',
  compress_nothing: '当前对话还没有可压缩的内容',
  wait_current: '请等待当前回复结束',
  no_model: '还没有可用模型，运行 dgxay config init',
  model_switched: '已切换到',
  provider_switched: '已切换到',
  skill_enabled: '已在本次对话启用技能',
  skill_none: '还没有安装技能。把 name.md 或 <目录>/SKILL.md 放到 ~/.dcb/skills',
  skill_not_found: '未找到该技能',
  skills_off: '已关闭技能',
  perms_title: '权限',
  perm_set: '权限已切换为',
  perm_auto_unavailable: '自动审查不可用：尚未配置审查模型',
  perm_full_warning: '完全权限下 AI 可以执行任意命令、读写任意文件，且不会询问',
  mode_set: '模式已切换为',
  workspace_set: '工作空间',
  dir_not_found: '目录不存在',
  not_a_dir: '不是文件夹',
  no_workspace: '未选择工作空间',
  context_title: '上下文',
  used: '已用',
  remaining: '剩余',
  context_note: '按字符启发式估算，实际 token 以模型 usage 为准。',
  mcp_title: 'MCP Server',
  mcp_none: '还没有 MCP Server，用 dgxay mcp add 添加',
  mcp_unknown: '未知的 /mcp 子命令',
  bye: '再见。用 dgxay -c 继续上一次对话。',
  cancelled: '已取消',
  session_not_found: '找不到会话',
  delete_confirm: '删除这段对话？',
  terminal_running: '已有命令正在执行',
  command_empty: '请输入要执行的终端命令',
  perm_denied_terminal: '无权限模式禁止执行终端命令',
  model_list_title: '模型',
  provider_list_title: '供应商',
  current: '当前',
  key_hint_and: '与',
  err_title: '出错了',
  err_network: '网络错误',
  err_unauthorized: '未授权：检查 API Key 或重新连接账户'
};

const LANG = String(process.env.DGXAY_LANG || process.env.DGXAY_LANGUAGE || 'en').toLowerCase();
const TABLE = LANG.startsWith('zh') || LANG === 'cn' ? ZH : EN;

const LANGUAGES = { en: EN, zh: ZH };

/** 取文案；缺失时回退英文，再回退 key 本身（避免界面出现 undefined） */
function t(key, ...args) {
  const table = TABLE[key] !== undefined ? TABLE : EN;
  const raw = table[key] !== undefined ? table[key] : key;
  return String(raw).replace(/\{(\d+)\}/g, (m, index) => {
    const value = args[Number(index)];
    return value === undefined ? m : String(value);
  });
}

function lang() {
  return TABLE === ZH ? 'zh' : 'en';
}

module.exports = { t, lang, LANGUAGES, EN, ZH };
