'use strict';

/**
 * 交互模式（REPL）：把桌面版的对话界面完整搬到终端。
 *
 *   dgxay                 进入交互模式（自动恢复最近会话）
 *   dgxay "问题"          单次对话
 *   dgxay -c / -r <id>    继续最近会话 / 指定会话
 *
 * 保留的桌面能力：会话列表与恢复、斜杠命令、技能、四档权限与自动审查、
 * 上下文压缩、`!` 终端、模型/供应商切换、MCP 管理、OAuth、工作空间选择。
 * 去掉的只有 UI：上下文圆环改为状态行 + /context，弹窗改为终端里的确认框。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { COLORS, SIGN, termWidth, setColorMode, colorEnabled, displayWidth } = require('./ansi');
const { LineEditor, createLineReader } = require('./editor');
const { parseArgs } = require('./args');
const print = require('./print');
const { askApproval } = require('./approval');
const { SLASH_COMMANDS, findCommand, completer } = require('./slash');
const { StreamRenderer } = require('./render');
const { contextInfo, ringLine, contextReport } = require('./ui');
const state = require('./repl-state');

const sessions = require('../core/sessions');
const settings = require('../services/settings');
const cfg = require('../services/config');
const skills = require('../services/skills');
const mcp = require('../core/mcp');
const oauth = require('../core/oauth');
const terminal = require('../services/terminal');
const sessionBus = require('../services/session-bus');
const { runAgent, HISTORY_LIMIT } = require('../core/agent');
const { compressMessages } = require('../core/prompt');
const { VERSION, BIN } = require('../services/version');

const GLOBAL_REPL_OPTIONS = [
  { name: 'print', alias: 'p', type: 'boolean' },
  { name: 'prompt', type: 'string' },
  { name: 'mode', alias: 'm', type: 'string' },
  { name: 'permission', type: 'string' },
  { name: 'workspace', alias: 'C', type: 'string' },
  { name: 'model', type: 'string' },
  { name: 'provider', type: 'string' },
  { name: 'skill', type: 'string' },
  { name: 'resume', alias: 'r', type: 'string' },
  { name: 'continue', alias: 'c', type: 'boolean' },
  { name: 'output', alias: 'o', type: 'string' },
  { name: 'yes', alias: 'y', type: 'boolean' }
];

function createRuntime(options = {}) {
  const st = state.createState();
  const config = settings.readConfig();
  const model = settings.activeModel(config);
  const provider = settings.activeProvider(config);

  st.runtime.mode = ['chat', 'work'].includes(options.mode) ? options.mode : settings.currentMode(config);
  st.runtime.permission = settings.PERMISSIONS[options.permission]
    ? options.permission
    : settings.currentPermission(config);
  if (st.runtime.permission === 'auto' && !settings.hasReviewModel(config)) st.runtime.permission = 'normal';
  st.runtime.modelId = options.model || model?.id || '';
  st.runtime.providerId = options.provider
    ? settings.findProvider(options.provider)?.id || provider?.id || ''
    : provider?.id || '';
  st.runtime.skill = String(options.skill || '');

  if (options.workspace) {
    const resolved = path.resolve(options.workspace);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) st.cwd = resolved;
    else throw Object.assign(new Error(`工作空间不存在：${options.workspace}`), { userError: true });
  } else if (config.work?.workspace && fs.existsSync(config.work.workspace)) {
    st.cwd = config.work.workspace;
  } else {
    st.cwd = process.cwd();
  }

  if (options.resume) {
    st.chat = sessions.getChat(String(options.resume));
    if (!st.chat) throw Object.assign(new Error(`找不到会话：${options.resume}`), { userError: true });
  } else if (options.continueLast) {
    st.chat = sessions.listChats()[0] || null;
  }

  st.yes = Boolean(options.yes);
  return st;
}

/* ------------------------------ 展示 ------------------------------ */

function permissionBadge(st) {
  const meta = settings.PERMISSIONS[st.runtime.permission] || settings.PERMISSIONS.normal;
  const tone = st.runtime.permission === 'full' ? COLORS.red : st.runtime.permission === 'auto' ? COLORS.green : COLORS.faint;
  return tone(meta.label);
}

function modeBadge(st) {
  return st.runtime.mode === 'work' ? COLORS.accent('工作') : COLORS.faint('对话');
}

function promptFor(st) {
  const model = settings.activeModel(settings.readConfig());
  const name = model?.name || '未选择模型';
  const marker = st.runtime.mode === 'work' ? COLORS.accent('❯') : COLORS.faint('❯');
  const skillChip = st.runtime.skill ? ` ${COLORS.accent(`⛭ ${st.runtime.skill}`)}` : '';
  return `${marker} ${COLORS.faint(name)}${skillChip} `
}

function showStatus(st, { withRing = true } = {}) {
  const chat = st.chat;
  const model = settings.activeModel(settings.readConfig());
  const info = contextInfo(chat, model);
  const parts = [
    modeBadge(st),
    permissionBadge(st),
    state.workspaceLabel(st.cwd),
    `${chat ? chat.messages.filter((m) => m.role !== 'terminal').length : 0} 条消息`
  ];
  const left = parts.filter(Boolean).join(COLORS.faint(' · '));
  const right = withRing ? ringLine(info) : '';
  const width = termWidth();
  const gap = Math.max(2, width - COLORS.dim('').length - stripLen(left) - stripLen(right) - 2);
  process.stdout.write(`\n${left}${' '.repeat(gap)}${right}\n\n`);
}

function stripLen(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').length;
}

function showWelcome(st) {
  require('./index').showBanner();
  const config = settings.readConfig();
  const model = settings.activeModel(config);
  const chat = st.chat;
  if (chat && chat.messages.length) {
    print.hint(`已恢复会话「${chat.title}」（${chat.messages.filter((m) => m.role !== 'terminal').length} 条消息）`);
  }
  print.keyValue([
    { label: '模型', value: model ? `${model.providerName} / ${model.name}` : COLORS.yellow('未配置，运行 dgxay config init') },
    { label: '工作空间', value: st.cwd },
    { label: '权限', value: `${settings.PERMISSIONS[st.runtime.permission].label} · ${settings.PERMISSIONS[st.runtime.permission].desc}` },
    { label: '模式', value: st.runtime.mode === 'work' ? '工作模式' : '对话模式' }
  ]);
  if (!model) {
    print.blank();
    print.warn('还没有可用模型，请输入 /config 或退出后运行 dgxay config init');
  }
  print.blank();
  print.hint('提示：/ 查看命令 · ! 执行终端命令 · \\ 结尾换行 · Ctrl+C 中断 · Ctrl+D 退出');
  print.blank();
  void chat;
}

/* ------------------------------ 消息与历史 ------------------------------ */

function ensureChat(st) {
  if (st.chat) return st.chat;
  const chat = sessions.createChat({ mode: st.runtime.mode, skill: st.runtime.skill });
  st.chat = chat;
  return chat;
}

function pushMessage(chat, message) {
  chat.messages.push({ ts: Date.now(), ...message });
  chat.updatedAt = Date.now();
}

function persist(st) {
  if (!st.chat) return;
  const chat = st.chat;
  if (!chat.messages.length) return;
  if (!chat.title || chat.title === '新对话') {
    const firstUser = chat.messages.find((m) => m.role === 'user' && m.content);
    if (firstUser) chat.title = sessions.titleFrom(firstUser.content);
  }
  try {
    sessions.saveChat(chat);
  } catch {
    /* ignore */
  }
}

/** 每轮请求都会重建 apiMessages，这里与桌面版一致：只发送最近 24 条 */
function historyForAgent(st) {
  return sessions.trimHistory(sessions.buildHistory(st.chat), HISTORY_LIMIT);
}

/* ------------------------------ 对话 ------------------------------ */

async function sendMessage(st, editor, text, options = {}) {
  const promptText = String(text || '').trim();
  if (!promptText) return 0;
  const config = settings.readConfig();
  const model = settings.activeModel({
    ...config,
    activeProviderId: st.runtime.providerId || config.activeProviderId,
    activeModelId: st.runtime.modelId || config.activeModelId
  });
  if (!model) {
    print.warn('还没有可用模型：先运行 dgxay config init 配置供应商');
    return 1;
  }

  const chat = ensureChat(st);
  chat.mode = st.runtime.mode;
  chat.skill = st.runtime.skill;
  pushMessage(chat, { role: 'user', content: promptText, mode: st.runtime.mode, permission: st.runtime.permission });
  persist(st);

  const jsonMode = String(options.output || 'text') === 'json';
  const renderer = new StreamRenderer({
    output: process.stdout,
    editor,
    redraw: Boolean(process.stdout.isTTY) && !jsonMode
  });
  const controller = new AbortController();
  st.requestController = controller;
  st.streaming = true;
  st.abortRequested = false;
  editor.setAbortHandler(() => {
    if (!st.streaming || st.abortRequested) return false;
    st.abortRequested = true;
    controller.abort();
    process.stdout.write(`${COLORS.yellow(`${SIGN.bullet} 正在中断…`)}\n`);
    return true;
  });

  const startedAt = Date.now();
  let result;
  try {
    result = await runAgent({
      config,
      messages: historyForAgent(st),
      providerId: st.runtime.providerId,
      modelId: st.runtime.modelId,
      mode: st.runtime.mode,
      permission: st.runtime.permission,
      workspace: st.cwd,
      skill: st.runtime.skill,
      signal: controller.signal,
      askUser: async (request) => {
        if (st.yes) return true;
        // 先让渲染器把已收到的正文落地并收起预览行，再暂停编辑器后弹出确认框
        renderer.endInline();
        editor.suspend();
        const allowed = await askApproval(request);
        editor.resume();
        return allowed;
      },
      onEvent: (event) => {
        if (jsonMode && !['review', 'review-start', 'waiting', 'file'].includes(event.type)) return;
        renderer.handle(event);
      }
    });
  } finally {
    st.streaming = false;
    st.abortRequested = false;
    st.requestController = null;
    editor.setAbortHandler(null);
  }

  const assistantMessage = {
    role: 'assistant',
    content: result.text || '',
    error: result.error || '',
    reasoningChars: result.reasoning?.length || 0,
    usage: result.usage || null,
    toolLog: result.toolLog,
    files: result.files,
    elapsedMs: Date.now() - startedAt
  };
  pushMessage(chat, assistantMessage);
  if (chat.title === '新对话') chat.title = sessions.titleFrom(promptText);
  persist(st);
  st.lastResponse = result;
  updateBusState(st);

  if (result.error) return 1;
  return 0;
}

/* ------------------------------ 终端命令 ------------------------------ */

async function runTerminal(st, editor, rawCommand) {
  const command = String(rawCommand || '').trim();
  if (!command) {
    print.warn('请输入要执行的终端命令');
    return 1;
  }
  if (st.terminalBusy) {
    print.warn('已有命令正在执行');
    return 1;
  }
  const config = settings.readConfig();
  const permission = st.runtime.permission;
  if (permission === 'none') {
    print.warn('无权限模式禁止执行终端命令');
    return 1;
  }

  if (permission === 'normal' || permission === 'auto') {
    editor.suspend();
    const allowed = await askApproval(
      {
        title: 'AI 请求执行终端命令',
        operation: 'run_terminal',
        detail: `命令：${command}`,
        command,
        workspace: st.cwd,
        review: '',
        reviewer: ''
      },
      {}
    );
    editor.resume();
    if (!allowed) return 1;
  }

  const chat = ensureChat(st);
  const message = {
    role: 'terminal',
    command,
    cwd: st.cwd,
    output: '',
    stderr: '',
    status: 'running',
    ts: Date.now()
  };
  chat.messages.push(message);
  st.terminalBusy = true;

  editor.suspend();
  process.stdout.write(`\n${COLORS.faint(`  ${SIGN.arrow} ${command}`)}\n`);
  const result = await terminal.runShellCommand({
    command,
    workspace: st.cwd,
    onOutput: (chunk) => {
      process.stdout.write(chunk);
      if (!message._streamed) message._streamed = '';
      message._streamed += chunk;
    }
  });
  st.terminalBusy = false;

  message.output = result.output;
  message.stderr = result.stderr;
  message.exitCode = Number.isInteger(result.code) ? result.code : null;
  message.status = result.aborted ? 'done' : result.code === 0 ? 'done' : 'error';
  if (result.error) message.error = result.error;
  if (chat.title === '新对话') chat.title = sessions.titleFrom(`终端 · ${command}`);
  chat.updatedAt = Date.now();
  persist(st);

  const code = message.exitCode;
  if (result.aborted) print.hint('已停止');
  else if (code === 0) process.stdout.write(COLORS.green(`  ${SIGN.ok} 完成\n`));
  else process.stdout.write(COLORS.red(`  ${SIGN.fail} 退出码 ${code ?? '未知'}\n`));
  editor.resume();
  return code === 0 ? 0 : 1;
}

/* ------------------------------ 状态栏刷新 ------------------------------ */

function updateBusState(st) {
  try {
    sessionBus.write({
      pid: process.pid,
      cwd: st.cwd,
      chatId: st.chat?.id || '',
      title: st.chat?.title || '',
      mode: st.runtime.mode,
      permission: st.runtime.permission,
      providerId: st.runtime.providerId,
      modelId: st.runtime.modelId,
      skill: st.runtime.skill,
      streaming: st.streaming
    });
  } catch {
    /* ignore */
  }
}

/* ------------------------------ 斜杠命令 ------------------------------ */

async function handleSlash(st, editor, input) {
  const text = String(input || '').trim();
  const [head, ...restParts] = text.split(/\s+/);
  const rest = restParts.join(' ').trim();
  const command = findCommand(head);

  if (!command) {
    print.warn(`未知命令：${head}，输入 /help 查看全部命令`);
    return;
  }

  switch (command.name) {
    case '/help':
      showHelp();
      return;
    case '/new': {
      persist(st);
      st.chat = sessions.createChat({ mode: st.runtime.mode, skill: st.runtime.skill });
      updateBusState(st);
      print.ok('已开始新对话');
      return;
    }
    case '/list':
      listChats(st);
      return;
    case '/resume': {
      const chats = sessions.listChats();
      if (!chats.length) {
        print.warn('还没有历史对话');
        return;
      }
      let target;
      try {
        target = sessions.resolveChat(rest || '1', chats);
      } catch (err) {
        print.fail(err.message);
        return;
      }
      if (!target) {
        print.fail(`找不到会话：${rest}`);
        return;
      }
      persist(st);
      st.chat = target;
      updateBusState(st);
      print.ok(`已恢复「${target.title}」（${target.messages.filter((m) => m.role !== 'terminal').length} 条消息）`);
      printThread(st);
      return;
    }
    case '/delete': {
      const chats = sessions.listChats();
      const target = rest ? sessions.resolveChat(rest, chats) : st.chat;
      if (!target) {
        print.fail(`找不到会话：${rest}`);
        return;
      }
      sessions.deleteChat(target.id);
      if (st.chat?.id === target.id) st.chat = sessions.listChats()[0] || null;
      updateBusState(st);
      print.ok(`已删除「${target.title}」`);
      return;
    }
    case '/rename': {
      if (!st.chat) {
        print.warn('当前没有会话');
        return;
      }
      if (!rest) {
        print.fail('用法：/rename <新标题>');
        return;
      }
      st.chat.title = rest;
      persist(st);
      print.ok(`已重命名为「${rest}」`);
      return;
    }
    case '/compress':
      await compress(st, editor);
      return;
    case '/skill':
      await handleSkillCommand(st, rest);
      return;
    case '/model':
      handleModelCommand(st, rest);
      return;
    case '/provider':
      handleProviderCommand(st, rest);
      return;
    case '/mode':
      handleModeCommand(st, rest);
      return;
    case '/permission':
      handlePermissionCommand(st, rest);
      return;
    case '/cd':
      handleCd(st, rest);
      return;
    case '/ls':
      handleLs(st, rest);
      return;
    case '/pwd':
      print.write(st.cwd);
      return;
    case '/term':
      await runTerminal(st, editor, rest);
      return;
    case '/context': {
      const config = settings.readConfig();
      const model = settings.activeModel(config);
      process.stdout.write(`\n${contextReport(contextInfo(st.chat, model))}\n\n`);
      return;
    }
    case '/mcp':
      await handleMcpCommand(st, rest);
      return;
    case '/theme':
      handleTheme(rest);
      return;
    case '/clear':
      process.stdout.write('\x1b[2J\x1b[H');
      return;
    case '/exit':
      st.exitRequested = true;
      return;
    default:
      print.warn(`命令尚未实现：${command.name}`);
  }
}

function showHelp() {
  print.blank();
  print.heading('斜杠命令');
  // 命令名列按显示宽度对齐（中文别名占两格，不能用 padEnd）
  const nameWidth = Math.max(...SLASH_COMMANDS.map((cmd) => displayWidth(cmd.name))) + 2;
  for (const cmd of SLASH_COMMANDS) {
    const name = `${cmd.name}${' '.repeat(Math.max(0, nameWidth - displayWidth(cmd.name)))}`;
    print.write(`  ${COLORS.accent(name)}${cmd.desc}`);
    if (cmd.usage !== cmd.name) print.write(`  ${' '.repeat(nameWidth)}${COLORS.faint(cmd.usage)}`);
  }
  print.blank();
  print.heading('输入约定');
  const tips = [
    ['! 命令', '执行终端命令，输出进入对话上下文（如 !git status）'],
    ['\\ 结尾', '续行输入多行消息'],
    ['Tab', '在 / 命令后循环选择补全项'],
    ['Ctrl+C', '生成中中断；空闲时退出；输入框有内容时清空'],
    ['Ctrl+D', '退出'],
    ['↑ / ↓', '浏览历史输入']
  ];
  for (const [key, desc] of tips) {
    print.write(`  ${COLORS.cyan(key)}  ${desc}`);
  }
  print.blank();
  print.hint(`其他操作也可以直接用子命令：${BIN} provider list / ${BIN} mcp start ...`);
  print.blank();
}

function listChats(st) {
  const chats = sessions.listChats();
  print.blank();
  if (!chats.length) {
    print.hint('还没有历史对话');
    return;
  }
  print.heading(`历史对话（${chats.length}）`);
  const rows = chats.map((chat, index) => {
    const messages = chat.messages.filter((m) => m.role !== 'terminal');
    const last = messages[messages.length - 1];
    const date = new Date(chat.updatedAt || chat.createdAt);
    const stamp = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(
      date.getHours()
    ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return [
      chat.id === st.chat?.id ? COLORS.accent('*') : ' ',
      String(index + 1),
      chat.title || '新对话',
      String(messages.length),
      stamp,
      chat.mode === 'work' ? '工作' : '对话',
      last?.content ? last.content.slice(0, 40) : ''
    ];
  });
  print.table(
    [
      { title: '', max: 1 },
      { title: '#', max: 3 },
      { title: '标题', max: 30 },
      { title: '消息', max: 4 },
      { title: '更新时间', max: 12 },
      { title: '模式', max: 4 },
      { title: '最后内容', max: 40 }
    ],
    rows
  );
  print.blank();
  print.hint('/resume <序号> 恢复 · /delete <序号> 删除');
}

function printThread(st) {
  const chat = st.chat;
  if (!chat?.messages?.length) return;
  for (const message of chat.messages) {
    if (message.role === 'user') {
      process.stdout.write(`\n${COLORS.faint('› 你')}\n${message.content}\n`);
    } else if (message.role === 'assistant') {
      process.stdout.write(`\n${COLORS.accent('•')} ${COLORS.bold('DgxayCode')}\n`);
      if (message.content) process.stdout.write(require('./ansi').renderMarkdown(message.content, { width: termWidth() }));
      if (message.error) process.stdout.write(COLORS.red(message.error) + '\n');
    } else if (message.role === 'terminal') {
      process.stdout.write(`\n${COLORS.faint(`! ${message.command}`)}\n`);
      process.stdout.write(`${message.output || ''}${message.stderr || ''}`.slice(-4000));
      if (!String(message.output || '').endsWith('\n')) process.stdout.write('\n');
    }
  }
  process.stdout.write('\n');
}

async function compress(st, editor) {
  if (st.streaming) {
    print.warn('请等待当前回复结束');
    return;
  }
  const chat = st.chat;
  if (!chat?.messages?.length) {
    print.warn('当前对话还没有可压缩的内容');
    return;
  }
  const config = settings.readConfig();
  const model = settings.activeModel(config);
  if (!model) {
    print.warn('请先配置模型');
    return;
  }
  const before = sessions.estimateChatTokens(chat);
  editor.suspend();
  process.stdout.write(`${COLORS.faint(`${SIGN.run} 正在压缩上下文…`)}`);
  try {
    const result = await compressMessages({
      config,
      providerId: st.runtime.providerId || config.activeProviderId,
      modelId: st.runtime.modelId || config.activeModelId,
      messages: sessions.buildHistory(chat)
    });
    if (!result.summary) throw new Error('模型没有返回摘要');
    chat.messages = [
      { role: 'assistant', content: `> 上下文已压缩，仅保留重要信息。\n\n${result.summary}`, ts: Date.now(), compressed: true }
    ];
    chat.updatedAt = Date.now();
    persist(st);
    const after = sessions.estimateChatTokens(chat);
    process.stdout.write('\r\x1b[2K');
    print.ok(`上下文已压缩：${sessions.formatTokens(before)} → ${sessions.formatTokens(after)} tokens（估算）`);
    process.stdout.write(`\n${require('./ansi').renderMarkdown(result.summary, { width: termWidth() })}\n`);
  } catch (err) {
    process.stdout.write('\r\x1b[2K');
    print.fail(err.message || '压缩失败');
  } finally {
    editor.resume();
  }
}

async function handleSkillCommand(st, rest) {
  if (!rest) {
    print.blank();
    print.heading(`技能（${settings.homeRelative(cfg.SKILLS_DIR)}）`);
    const list = skills.listSkills();
    if (!list.length) {
      print.hint('  还没有技能。在 ~/.dcb/skills 下放一个 name.md 或 <目录>/SKILL.md');
      print.blank();
      return;
    }
    const rows = list.map((skill, index) => [
      String(index + 1),
      skill.name,
      st.runtime.skill === skill.name ? COLORS.green('已启用') : '',
      skill.description
    ]);
    print.table(
      [
        { title: '#', max: 3 },
        { title: '名称', max: 22 },
        { title: '状态', max: 8 },
        { title: '描述', max: 60 }
      ],
      rows
    );
    print.blank();
    print.hint('/skill off 关闭 · /skill <名称> [提示词] 启用（本次对话）');
    print.blank();
    return;
  }
  if (rest === 'off' || rest === 'clear') {
    st.runtime.skill = '';
    if (st.chat) st.chat.skill = '';
    updateBusState(st);
    print.ok('已关闭技能');
    return;
  }
  const list = skills.listSkills();
  const picked = list
    .filter((item) => rest === item.name || rest.startsWith(`${item.name} `))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!picked) {
    print.warn(`未找到技能：${rest}。输入 /skill 查看列表`);
    return;
  }
  st.runtime.skill = picked.name;
  if (st.chat) st.chat.skill = picked.name;
  updateBusState(st);
  print.ok(`已在本次对话启用技能：${picked.name}`);
  const prompt = rest.slice(picked.name.length).trim();
  if (prompt) return prompt;
  return undefined;
}

function handleModelCommand(st, rest) {
  const config = settings.readConfig();
  const provider = settings.findProvider(st.runtime.providerId) || settings.activeProvider(config);
  const models = provider?.models || [];
  if (!models.length) {
    print.warn('当前供应商没有模型，先运行 dgxay provider add');
    return;
  }
  const current = models.find((m) => m.id === st.runtime.modelId) || models[0];
  if (!rest) {
    print.blank();
    print.heading(`模型（${provider.name}）`);
    models.forEach((model, index) => {
      const active = model.id === current?.id;
      print.write(
        `  ${active ? COLORS.accent('❯') : ' '} ${COLORS.faint(String(index + 1).padStart(2))}. ${
          active ? COLORS.accent(model.name || model.id) : model.name || model.id
        } ${COLORS.faint(model.id !== (model.name || model.id) ? `(${model.id})` : '')}${
          model.contextWindow ? COLORS.faint(` · ${sessions.formatTokens(model.contextWindow)}`) : ''
        }`
      );
    });
    print.blank();
    print.hint('/model <序号|ID> 切换 · 该选择会写入配置');
    print.blank();
    return;
  }
  const index = Number(rest);
  const target =
    (Number.isInteger(index) && index >= 1 && index <= models.length ? models[index - 1] : null) ||
    models.find((m) => m.id === rest) ||
    models.find((m) => m.id.includes(rest));
  if (!target) {
    print.fail(`找不到模型：${rest}`);
    return;
  }
  settings.setActiveModel(provider.id, target.id);
  st.runtime.modelId = target.id;
  st.runtime.providerId = provider.id;
  updateBusState(st);
  print.ok(`已切换到 ${target.name || target.id}`);
}

function handleProviderCommand(st, rest) {
  const config = settings.readConfig();
  const providers = config.providers || [];
  if (!providers.length) {
    print.warn('还没有供应商，运行 dgxay config init');
    return;
  }
  const current = settings.findProvider(st.runtime.providerId) || settings.activeProvider(config);
  if (!rest) {
    print.blank();
    print.heading('供应商');
    providers.forEach((provider, index) => {
      const active = provider.id === current?.id;
      print.write(
        `  ${active ? COLORS.accent('❯') : ' '} ${COLORS.faint(String(index + 1).padStart(2))}. ${
          active ? COLORS.accent(provider.name) : provider.name
        } ${COLORS.faint(settings.PROTOCOL_META[provider.protocol || 'openai'].short)} ${COLORS.faint(
          `${(provider.models || []).length} 个模型`
        )}`
      );
    });
    print.blank();
    print.hint('/provider <序号|名称> 切换');
    print.blank();
    return;
  }
  const index = Number(rest);
  const target =
    (Number.isInteger(index) && index >= 1 && index <= providers.length ? providers[index - 1] : null) ||
    settings.findProvider(rest);
  if (!target) {
    print.fail(`找不到供应商：${rest}`);
    return;
  }
  const model = target.models?.[0];
  if (!model) {
    print.fail(`供应商 ${target.name} 没有模型`);
    return;
  }
  settings.saveConfig({ activeProviderId: target.id, activeModelId: model.id });
  st.runtime.providerId = target.id;
  st.runtime.modelId = model.id;
  updateBusState(st);
  print.ok(`已切换到 ${target.name} / ${model.name || model.id}`);
}

function handleModeCommand(st, rest) {
  const next = rest ? (rest === 'work' || rest === '工作' ? 'work' : 'chat') : st.runtime.mode === 'work' ? 'chat' : 'work';
  st.runtime.mode = next;
  if (st.chat) st.chat.mode = next;
  updateBusState(st);
  print.ok(next === 'work' ? '已切换到工作模式' : '已切换到对话模式');
  if (next === 'work' && !st.cwd) print.hint('当前没有工作空间，请用 /cd <目录> 选择');
}

function handlePermissionCommand(st, rest) {
  const config = settings.readConfig();
  if (!rest) {
    print.blank();
    print.heading('权限');
    const available = settings.availablePermissions(config);
    Object.entries(settings.PERMISSIONS).forEach(([key, meta]) => {
      const usable = available.includes(key);
      const active = st.runtime.permission === key;
      print.write(
        `  ${active ? COLORS.accent('❯') : ' '} ${COLORS.faint(key.padEnd(8))} ${
          usable ? meta.label : COLORS.faint(`${meta.label}（不可用）`)
        }  ${COLORS.faint(meta.desc)}`
      );
    });
    if (!available.includes('auto')) print.hint('自动审查需要供应商配置有效的审查模型');
    print.blank();
    return;
  }
  if (!settings.PERMISSIONS[rest]) {
    print.fail('权限只能是 none / normal / auto / full');
    return;
  }
  if (rest === 'auto' && !settings.hasReviewModel(config)) {
    print.fail('自动审查不可用：当前或默认供应商没有配置有效的审查模型');
    return;
  }
  st.runtime.permission = rest;
  settings.setPermission(rest);
  updateBusState(st);
  print.ok(`权限已切换为：${settings.PERMISSIONS[rest].label}`);
  if (rest === 'full') print.warn('完全权限下 AI 可以直接执行任意命令、读写任意文件，请确认这是你想要的');
}

function handleCd(st, rest) {
  if (!rest) {
    print.write(st.cwd);
    return;
  }
  const target = path.resolve(st.cwd, rest);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    print.fail(`目录不存在：${target}`);
    return;
  }
  if (!stat.isDirectory()) {
    print.fail(`不是文件夹：${target}`);
    return;
  }
  st.cwd = target;
  settings.setWorkspace(target);
  updateBusState(st);
  print.ok(`工作空间：${target}`);
}

function handleLs(st, rest) {
  const target = rest ? path.resolve(st.cwd, rest) : st.cwd;
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    print.fail(`无法读取 ${target}：${err.code || err.message}`);
    return;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  print.blank();
  print.write(COLORS.faint(`${target}`));
  for (const entry of entries.slice(0, 200)) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    let size = '';
    if (!entry.isDirectory()) {
      try {
        size = `${fs.statSync(path.join(target, entry.name)).size} B`;
      } catch {
        size = '';
      }
    }
    print.write(`  ${entry.isDirectory() ? COLORS.accent(`${entry.name}/`) : entry.name}${COLORS.faint(size ? `  ${size}` : '')}`);
  }
  print.blank();
}

async function handleMcpCommand(st, rest) {
  const [action, ...others] = rest.split(/\s+/).filter(Boolean);
  const arg = others.join(' ');
  if (!action || action === 'list' || action === 'ls') {
    const list = mcp.listServers();
    print.blank();
    if (!list.length) {
      print.hint(`还没有 MCP server，用 /mcp add 或 ${BIN} mcp add 添加`);
      print.blank();
      return;
    }
    print.heading(`MCP Server（${list.length}）`);
    const rows = list.map((server, index) => [
      String(index + 1),
      server.name,
      server.status === 'running' ? COLORS.green('运行中') : server.status === 'error' ? COLORS.red('异常') : '已停止',
      server.pid ? String(server.pid) : '',
      `${server.command} ${(server.args || []).join(' ')}`
    ]);
    print.table(
      [
        { title: '#', max: 3 },
        { title: '名称', max: 18 },
        { title: '状态', max: 8 },
        { title: 'PID', max: 8 },
        { title: '命令', max: 50 }
      ],
      rows
    );
    print.blank();
    print.hint('/mcp start <名称> · /mcp stop <名称> · /mcp logs <名称> · /mcp add name command args');
    print.blank();
    return;
  }
  const server = mcp.findServer(arg);
  if (action === 'start') {
    if (!server) return print.fail(`找不到 MCP：${arg}`);
    try {
      const result = mcp.startServer(server.id);
      print.ok(`已启动 ${server.name}（pid ${result.pid}）`);
    } catch (err) {
      print.fail(err.message);
    }
    return;
  }
  if (action === 'stop') {
    if (!server) return print.fail(`找不到 MCP：${arg}`);
    mcp.stopServer(server.id);
    print.ok(`已停止 ${server.name}`);
    return;
  }
  if (action === 'logs') {
    if (!server) return print.fail(`找不到 MCP：${arg}`);
    const logs = mcp.statusOf(server.id).logs || [];
    if (!logs.length) return print.hint('暂无日志');
    for (const entry of logs) {
      print.write(`${entry.stream === 'stderr' ? COLORS.red(entry.text) : entry.text}`);
    }
    return;
  }
  if (action === 'add') {
    const [name, command, ...args] = others;
    if (!name || !command) return print.fail('用法：/mcp add <名称> <命令> [参数…]');
    const created = mcp.addServer({ name, command, args });
    print.ok(`已添加 MCP「${created.name}」，用 /mcp start ${created.name} 启动`);
    return;
  }
  if (action === 'rm' || action === 'remove') {
    if (!server) return print.fail(`找不到 MCP：${arg}`);
    mcp.removeServer(server.id);
    print.ok(`已删除 ${server.name}`);
    return;
  }
  print.fail(`未知的 /mcp 子命令：${action}`);
}

function handleTheme(rest) {
  const mode = String(rest || '').toLowerCase();
  if (mode === 'on' || mode === 'color') {
    setColorMode('ansi256');
    print.ok('已开启彩色输出');
    return;
  }
  if (mode === 'off' || mode === 'plain') {
    setColorMode('none');
    print.ok('已关闭彩色输出');
    return;
  }
  print.write(`彩色输出：${colorEnabled() ? '开启' : '关闭'}（/theme on | off）`);
}

/* ------------------------------ 输入分发 ------------------------------ */

async function handleInput(st, editor, raw) {
  const line = String(raw || '');
  const text = line.trim();
  if (!text) return;

  if (text.startsWith('/')) {
    const command = findCommand(text);
    if (command?.name === '/skill') {
      const result = await handleSkillCommand(st, text.split(/\s+/).slice(1).join(' ').trim());
      if (typeof result === 'string') return sendMessage(st, editor, result);
      return;
    }
    await handleSlash(st, editor, text);
    return;
  }

  if (text.startsWith('!') && text.length > 1) {
    editor.pushHistory(line);
    await runTerminal(st, editor, text.slice(1).trim());
    return;
  }

  // 技能命令后面可以附带提示词：/skill name 提示词
  editor.pushHistory(line);
  await sendMessage(st, editor, text);
}

/* ------------------------------ 主循环 ------------------------------ */

/** 单次运行（dgxay "问题" / -p）：与 run 子命令共用同一套逻辑 */
async function singleShot(options) {
  const argv = [];
  const prompt = String(options.initialPrompt || '').trim();
  if (prompt) argv.push('-p', prompt);
  if (options.mode) argv.push('--mode', options.mode);
  if (options.permission) argv.push('--permission', options.permission);
  if (options.workspace) argv.push('--workspace', options.workspace);
  if (options.model) argv.push('--model', options.model);
  if (options.provider) argv.push('--provider', options.provider);
  if (options.skill) argv.push('--skill', options.skill);
  if (options.resume) argv.push('--resume', options.resume);
  if (options.continueLast) argv.push('--continue');
  if (options.output) argv.push('--output', options.output);
  if (options.yes) argv.push('--yes');
  if (!prompt) {
    print.fail('单次运行需要提示词');
    return 2;
  }
  return require('../commands/run').run({ argv, runtime: options });
}

async function start(options = {}) {
  if (options.noColor) setColorMode('none');
  if (options.single || options.print) return singleShot(options);
  return startInteractive(options);
}

/** 交互模式主体 */
async function startInteractive(options) {
  const config = settings.readConfig();
  if (!config.providers?.length) {
    // 还没有任何供应商：交互终端里直接进入配置引导
    print.warn('还没有配置任何供应商');
    if (!process.stdin.isTTY) {
      print.hint('运行 dgxay config init 完成首次配置');
      return 1;
    }
    const result = await require('../commands/config').run({
      argv: ['init'],
      runtime: options
    });
    if (result !== 0) return result;
  }

  const st = createRuntime(options);
  const editor = process.stdin.isTTY && process.stdout.isTTY
    ? new LineEditor({
        prompt: promptFor(st),
        continuationPrompt: COLORS.faint('  … '),
        completer,
        multiline: true
      })
    : createLineReader(process.stdin);

  showWelcome(st);
  updateBusState(st);
  const heartbeat = new sessionBus.Heartbeat(() => ({
    pid: process.pid,
    cwd: st.cwd,
    chatId: st.chat?.id || '',
    title: st.chat?.title || '',
    mode: st.runtime.mode,
    permission: st.runtime.permission,
    providerId: st.runtime.providerId,
    modelId: st.runtime.modelId,
    skill: st.runtime.skill
  }));
  heartbeat.start();

  const cleanup = () => {
    heartbeat.stop();
    sessionBus.clear();
    editor.finish({ type: 'eof', value: '' });
    persist(st);
    mcp.killAll();
    try {
      editor.close?.();
    } catch {
      /* ignore */
    }
  };
  // 只在交互终端里接管信号；管道 / 脚本模式下不能注册 SIGINT 监听，
  // 否则 Node 会认为“有人在处理信号”，进程永远无法自然退出。
  const signalHandlers = {};
  if (process.stdin.isTTY) {
    signalHandlers.SIGINT = () => {
      if (st.streaming) {
        st.abortRequested = true;
        st.requestController?.abort();
        return;
      }
      cleanup();
      process.exit(0);
    };
    signalHandlers.SIGTERM = () => {
      cleanup();
      process.exit(0);
    };
    process.on('SIGINT', signalHandlers.SIGINT);
    process.on('SIGTERM', signalHandlers.SIGTERM);
  }

  editor.setAbortHandler(() => {
    if (st.streaming && !st.abortRequested) {
      st.abortRequested = true;
      st.requestController?.abort();
      process.stdout.write(`${COLORS.yellow(`${SIGN.bullet} 正在中断…`)}\n`);
      return true;
    }
    if (st.terminalBusy) return true;
    return false;
  });

  try {
    while (!st.exitRequested) {
      editor.prompt = promptFor(st);
      const answer = await editor.question();
      if (answer.type === 'eof' || answer.type === 'cancel') break;
      try {
        await handleInput(st, editor, answer.value);
      } catch (err) {
        if (err?.userError) print.fail(err.message);
        else {
          print.fail(err?.message || String(err));
          if (process.env.DGXAY_DEBUG === '1' && err?.stack) process.stderr.write(`${err.stack}\n`);
        }
      }
    }
  } finally {
    if (signalHandlers.SIGINT) process.removeListener('SIGINT', signalHandlers.SIGINT);
    if (signalHandlers.SIGTERM) process.removeListener('SIGTERM', signalHandlers.SIGTERM);
    heartbeat.stop();
    sessionBus.clear();
    persist(st);
    mcp.killAll();
    try {
      editor.close?.();
    } catch {
      /* ignore */
    }
    if (typeof process.stdin.pause === 'function') process.stdin.pause();
  }

  process.stdout.write(`${COLORS.faint('再见。用 dgxay -c 继续上一次对话。')}\n`);
  return 0;
}

module.exports = {
  start,
  startInteractive,
  createRuntime,
  handleInput,
  sendMessage,
  runTerminal,
  showHelp,
  permissionBadge,
  promptFor
};
