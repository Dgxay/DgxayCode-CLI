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

const { COLORS, SIGN, termWidth, setColorMode, colorEnabled, displayWidth, clearScreen, useUnicode } = require('./ansi');
const { t } = require('./i18n');
const { LineEditor, createLineReader, detectCapabilities, wrapDisplay } = require('./editor');
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
    else throw Object.assign(new Error(`Workspace not found: ${options.workspace}`), { userError: true });
  } else if (config.work?.workspace && fs.existsSync(config.work.workspace)) {
    st.cwd = config.work.workspace;
  } else {
    st.cwd = process.cwd();
  }

  if (options.resume) {
    st.chat = sessions.getChat(String(options.resume));
    if (!st.chat) throw Object.assign(new Error(`Conversation not found: ${options.resume}`), { userError: true });
  } else if (options.continueLast) {
    st.chat = sessions.listChats()[0] || null;
  }

  st.yes = Boolean(options.yes);
  return st;
}

/* ------------------------------ 展示 ------------------------------ */

function permissionBadge(st) {
  const tone =
    st.runtime.permission === 'full' ? COLORS.red : st.runtime.permission === 'auto' ? COLORS.green : COLORS.faint;
  return tone(t(`perm_${st.runtime.permission}`));
}

function modeBadge(st) {
  return st.runtime.mode === 'work' ? COLORS.accent(t('mode_work')) : COLORS.faint(t('mode_chat'));
}

/** 输入框上方的一行说明（模型 / 技能） */
function promptFor(st) {
  const model = settings.activeModel(settings.readConfig());
  const name = model?.name || t('no_model');
  const skill = st.runtime.skill ? ` · ⛭ ${st.runtime.skill}` : '';
  return `${name}${skill}`;
}

function showStatus(st, { withRing = true } = {}) {
  const chat = st.chat;
  const model = settings.activeModel(settings.readConfig());
  const info = contextInfo(chat, model);
  const parts = [
    modeBadge(st),
    permissionBadge(st),
    state.workspaceLabel(st.cwd),
    `${chat ? chat.messages.filter((m) => m.role !== 'terminal').length : 0} ${t('messages')}`
  ];
  const left = parts.filter(Boolean).join(COLORS.faint(' · '));
  const right = withRing ? ringLine(info) : '';
  const width = termWidth();
  const gap = Math.max(2, width - stripLen(left) - stripLen(right) - 2);
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
    print.hint(
      `${t('restored')} "${chat.title}" (${chat.messages.filter((m) => m.role !== 'terminal').length} ${t('messages')})`
    );
  }
  print.keyValue([
    {
      label: t('status_model'),
      value: model ? `${model.providerName} / ${model.name}` : COLORS.yellow(t('no_model'))
    },
    { label: t('status_workspace'), value: st.cwd },
    {
      label: t('status_permission'),
      value: `${t(`perm_${st.runtime.permission}`)} · ${settings.PERMISSIONS[st.runtime.permission].desc}`
    },
    { label: t('status_mode'), value: st.runtime.mode === 'work' ? t('mode_work') : t('mode_chat') }
  ]);
  print.blank();
  print.hint(t('hint_start'));
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
  if (!chat.title || chat.title === 'New conversation') {
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

/**
 * 回显用户消息：与输入框同样的边框样式，让对话记录看起来是「框」。
 */
function printUserMessage(text) {
  const width = Math.max(20, Math.min(termWidth() - 1, 100));
  const inner = width - 2;
  const unicode = useUnicode();
  const box = unicode
    ? { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

  const lines = [];
  for (const raw of String(text).split('\n')) {
    for (const piece of wrapDisplay(raw, Math.max(4, inner - 2))) lines.push(piece);
  }
  if (!lines.length) lines.push('');

  const label = ` ${t('you')} `;
  const topFill = Math.max(0, width - 2 - displayWidth(label));
  process.stdout.write(`\n${COLORS.accent(box.tl + label + box.h.repeat(topFill) + box.tr)}\n`);
  for (const line of lines) {
    const pad = Math.max(0, inner - displayWidth(line) - 1);
    process.stdout.write(`${COLORS.accent(box.v)} ${line}${' '.repeat(pad)}${COLORS.accent(box.v)}\n`);
  }
  process.stdout.write(`${COLORS.accent(box.bl + box.h.repeat(width - 2) + box.br)}\n`);
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
    print.warn(t('no_model'));
    return 1;
  }

  const chat = ensureChat(st);
  chat.mode = st.runtime.mode;
  chat.skill = st.runtime.skill;
  pushMessage(chat, { role: 'user', content: promptText, mode: st.runtime.mode, permission: st.runtime.permission });
  persist(st);
  // 记住上一条提示词，供输入框按 ↑ 回填
  st.lastUserPrompt = promptText;
  if (editor) editor.lastUserPrompt = promptText;

  // 把用户消息按输入框的样式回显一遍，形成对话记录
  printUserMessage(promptText);

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
    process.stdout.write(`${COLORS.yellow(`${SIGN.bullet} ${t('interrupted')}`)}\n`);
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
  if (chat.title === 'New conversation') chat.title = sessions.titleFrom(promptText);
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
    print.warn('Enter a command first');
    return 1;
  }
  if (st.terminalBusy) {
    print.warn('A command is already running');
    return 1;
  }
  const config = settings.readConfig();
  const permission = st.runtime.permission;
  if (permission === 'none') {
    print.warn('No permission to run shell commands');
    return 1;
  }

  if (permission === 'normal' || permission === 'auto') {
    editor.suspend();
    const allowed = await askApproval(
      {
        title: t('approval_terminal'),
        operation: 'run_terminal',
        detail: `Command: ${command}`,
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
  if (chat.title === 'New conversation') chat.title = sessions.titleFrom(`Terminal · ${command}`);
  chat.updatedAt = Date.now();
  persist(st);

  const code = message.exitCode;
  if (result.aborted) print.hint(t('stopped'));
  else if (code === 0) process.stdout.write(COLORS.green(`  ${SIGN.ok} done\n`));
  else process.stdout.write(COLORS.red(`  ${SIGN.fail} ${t('exit_code')} ${code ?? '?'}\n`));
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
    print.warn(`Unknown command: ${head}. Type /help to list commands`);
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
      print.ok(t('new_chat'));
      return;
    }
    case '/list':
      listChats(st);
      return;
    case '/resume': {
      const chats = sessions.listChats();
      if (!chats.length) {
        print.warn(t('no_chats'));
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
        print.fail(`Conversation not found: ${rest}`);
        return;
      }
      persist(st);
      st.chat = target;
      updateBusState(st);
      print.ok(`Restored "${target.title}" (${target.messages.filter((m) => m.role !== 'terminal').length} messages)`);
      printThread(st);
      return;
    }
    case '/delete': {
      const chats = sessions.listChats();
      const target = rest ? sessions.resolveChat(rest, chats) : st.chat;
      if (!target) {
        print.fail(`Conversation not found: ${rest}`);
        return;
      }
      sessions.deleteChat(target.id);
      if (st.chat?.id === target.id) st.chat = sessions.listChats()[0] || null;
      updateBusState(st);
      print.ok(`Deleted "${target.title}"`);
      return;
    }
    case '/rename': {
      if (!st.chat) {
        print.warn('No active conversation');
        return;
      }
      if (!rest) {
        print.fail('Usage: /rename <title>');
        return;
      }
      st.chat.title = rest;
      persist(st);
      print.ok(`Renamed to "${rest}"`);
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
      print.warn(`Not implemented yet: ${command.name}`);
  }
}

function showHelp() {
  print.blank();
  print.heading(t('menu_title'));
  // 命令名列按显示宽度对齐（中文别名占两格，不能用 padEnd）
  const nameWidth = Math.max(...SLASH_COMMANDS.map((cmd) => displayWidth(cmd.name))) + 2;
  for (const cmd of SLASH_COMMANDS) {
    const name = `${cmd.name}${' '.repeat(Math.max(0, nameWidth - displayWidth(cmd.name)))}`;
    print.write(`  ${COLORS.accent(name)}${cmd.desc}`);
    if (cmd.usage !== cmd.name) print.write(`  ${' '.repeat(nameWidth)}${COLORS.faint(cmd.usage)}`);
  }
  print.blank();
  print.heading('Keys');
  const tips = [
    ['! cmd', 'Run a shell command; output joins the context (e.g. !git status)'],
    ['\\', 'Continue on the next line (multi-line input)'],
    ['Tab', 'Open / cycle the completion menu'],
    ['Ctrl+C', 'Interrupt generation · exit when idle · clear input'],
    ['Ctrl+D', 'Exit'],
    ['↑ / ↓', 'Recalls the previous prompt']
  ];
  for (const [key, desc] of tips) {
    print.write(`  ${COLORS.cyan(key)}  ${desc}`);
  }
  print.blank();
  print.hint(`Everything is also available as a subcommand: ${BIN} provider list · ${BIN} mcp start`);
  print.blank();
}

function listChats(st) {
  const chats = sessions.listChats();
  print.blank();
  if (!chats.length) {
    print.hint(t('no_chats'));
    return;
  }
  print.heading(`Conversations (${chats.length}）`);
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
      chat.title || 'New conversation',
      String(messages.length),
      stamp,
      chat.mode === 'work' ? t('mode_work') : t('mode_chat'),
      last?.content ? last.content.slice(0, 40) : ''
    ];
  });
  print.table(
    [
      { title: '', max: 1 },
      { title: '#', max: 3 },
      { title: 'Title', max: 30 },
      { title: 'Msgs', max: 4 },
      { title: 'Updated', max: 12 },
      { title: 'Mode', max: 4 },
      { title: 'Last message', max: 40 }
    ],
    rows
  );
  print.blank();
  print.hint('/resume <n> restore · /delete <n> remove');
}

function printThread(st) {
  const chat = st.chat;
  if (!chat?.messages?.length) return;
  for (const message of chat.messages) {
    if (message.role === 'user') {
      process.stdout.write(`\n${COLORS.faint('› You')}\n${message.content}\n`);
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
    print.warn(t('wait_current'));
    return;
  }
  const chat = st.chat;
  if (!chat?.messages?.length) {
    print.warn(t('compress_nothing'));
    return;
  }
  const config = settings.readConfig();
  const model = settings.activeModel(config);
  if (!model) {
    print.warn(t('no_model'));
    return;
  }
  const before = sessions.estimateChatTokens(chat);
  editor.suspend();
  process.stdout.write(`${COLORS.faint(`${SIGN.run} Compressing context…`)}`);
  try {
    const result = await compressMessages({
      config,
      providerId: st.runtime.providerId || config.activeProviderId,
      modelId: st.runtime.modelId || config.activeModelId,
      messages: sessions.buildHistory(chat)
    });
    if (!result.summary) throw new Error('the model returned no summary');
    chat.messages = [
      { role: 'assistant', content: `> Context compressed; only key information kept.\n\n${result.summary}`, ts: Date.now(), compressed: true }
    ];
    chat.updatedAt = Date.now();
    persist(st);
    const after = sessions.estimateChatTokens(chat);
    process.stdout.write('\r\x1b[2K');
    print.ok(`Context compressed: ${sessions.formatTokens(before)} → ${sessions.formatTokens(after)} tokens (estimated)`);
    process.stdout.write(`\n${require('./ansi').renderMarkdown(result.summary, { width: termWidth() })}\n`);
  } catch (err) {
    process.stdout.write('\r\x1b[2K');
    print.fail(err.message || t('compress_failed'));
  } finally {
    editor.resume();
  }
}

async function handleSkillCommand(st, rest) {
  if (!rest) {
    print.blank();
    print.heading(`Skills (${settings.homeRelative(cfg.SKILLS_DIR)}）`);
    const list = skills.listSkills();
    if (!list.length) {
      print.hint('  No skills yet. Put a name.md or <dir>/SKILL.md into ~/.dcb/skills');
      print.blank();
      return;
    }
    const rows = list.map((skill, index) => [
      String(index + 1),
      skill.name,
      st.runtime.skill === skill.name ? COLORS.green('enabled') : '',
      skill.description
    ]);
    print.table(
      [
        { title: '#', max: 3 },
        { title: 'Name', max: 22 },
        { title: 'Status', max: 8 },
        { title: 'Description', max: 60 }
      ],
      rows
    );
    print.blank();
    print.hint('/skill off to disable · /skill <name> [prompt] to enable for this conversation');
    print.blank();
    return;
  }
  if (rest === 'off' || rest === 'clear') {
    st.runtime.skill = '';
    if (st.chat) st.chat.skill = '';
    updateBusState(st);
    print.ok(t('skills_off'));
    return;
  }
  const list = skills.listSkills();
  const picked = list
    .filter((item) => rest === item.name || rest.startsWith(`${item.name} `))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!picked) {
    print.warn(`Skill not found: ${rest}. Type /skill to list them`);
    return;
  }
  st.runtime.skill = picked.name;
  if (st.chat) st.chat.skill = picked.name;
  updateBusState(st);
  print.ok(`Skill enabled for this conversation: ${picked.name}`);
  const prompt = rest.slice(picked.name.length).trim();
  if (prompt) return prompt;
  return undefined;
}

function handleModelCommand(st, rest) {
  const config = settings.readConfig();
  const provider = settings.findProvider(st.runtime.providerId) || settings.activeProvider(config);
  const models = provider?.models || [];
  if (!models.length) {
    print.warn('This provider has no models. Run dgxay provider add');
    return;
  }
  const current = models.find((m) => m.id === st.runtime.modelId) || models[0];
  if (!rest) {
    print.blank();
    print.heading(`Models (${provider.name}）`);
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
    print.hint('/model <n|id> to switch · saved to config');
    print.blank();
    return;
  }
  const index = Number(rest);
  const target =
    (Number.isInteger(index) && index >= 1 && index <= models.length ? models[index - 1] : null) ||
    models.find((m) => m.id === rest) ||
    models.find((m) => m.id.includes(rest));
  if (!target) {
    print.fail(`Model not found: ${rest}`);
    return;
  }
  settings.setActiveModel(provider.id, target.id);
  st.runtime.modelId = target.id;
  st.runtime.providerId = provider.id;
  updateBusState(st);
  print.ok(`Switched to ${target.name || target.id}`);
}

function handleProviderCommand(st, rest) {
  const config = settings.readConfig();
  const providers = config.providers || [];
  if (!providers.length) {
    print.warn('No providers yet. Run dgxay config init');
    return;
  }
  const current = settings.findProvider(st.runtime.providerId) || settings.activeProvider(config);
  if (!rest) {
    print.blank();
    print.heading(t('provider_list_title'));
    providers.forEach((provider, index) => {
      const active = provider.id === current?.id;
      print.write(
        `  ${active ? COLORS.accent('❯') : ' '} ${COLORS.faint(String(index + 1).padStart(2))}. ${
          active ? COLORS.accent(provider.name) : provider.name
        } ${COLORS.faint(settings.PROTOCOL_META[provider.protocol || 'openai'].short)} ${COLORS.faint(
          `${(provider.models || []).length} models`
        )}`
      );
    });
    print.blank();
    print.hint('/provider <n|name> to switch');
    print.blank();
    return;
  }
  const index = Number(rest);
  const target =
    (Number.isInteger(index) && index >= 1 && index <= providers.length ? providers[index - 1] : null) ||
    settings.findProvider(rest);
  if (!target) {
    print.fail(`Provider not found: ${rest}`);
    return;
  }
  const model = target.models?.[0];
  if (!model) {
    print.fail(`Provider ${target.name} has no models`);
    return;
  }
  settings.saveConfig({ activeProviderId: target.id, activeModelId: model.id });
  st.runtime.providerId = target.id;
  st.runtime.modelId = model.id;
  updateBusState(st);
  print.ok(`Switched to ${target.name} / ${model.name || model.id}`);
}

function handleModeCommand(st, rest) {
  const next = rest ? (rest === 'work' ? 'work' : 'chat') : st.runtime.mode === 'work' ? 'chat' : 'work';
  st.runtime.mode = next;
  if (st.chat) st.chat.mode = next;
  updateBusState(st);
  print.ok(next === 'work' ? `${t('mode_set')}: ${t('mode_work')}` : `${t('mode_set')}: ${t('mode_chat')}`);
  if (next === 'work' && !st.cwd) print.hint('No workspace selected. Use /cd <dir>');
}

function handlePermissionCommand(st, rest) {
  const config = settings.readConfig();
  if (!rest) {
    print.blank();
    print.heading(t('perms_title'));
    const available = settings.availablePermissions(config);
    Object.entries(settings.PERMISSIONS).forEach(([key, meta]) => {
      const usable = available.includes(key);
      const active = st.runtime.permission === key;
      print.write(
        `  ${active ? COLORS.accent('❯') : ' '} ${COLORS.faint(key.padEnd(8))} ${
          usable ? meta.label : COLORS.faint(`${meta.label} (unavailable)`)
        }  ${COLORS.faint(meta.desc)}`
      );
    });
    if (!available.includes('auto')) print.hint('Auto review needs a valid review model');
    print.blank();
    return;
  }
  if (!settings.PERMISSIONS[rest]) {
    print.fail('Level must be none / normal / auto / full');
    return;
  }
  if (rest === 'auto' && !settings.hasReviewModel(config)) {
    print.fail(t('perm_auto_unavailable'));
    return;
  }
  st.runtime.permission = rest;
  settings.setPermission(rest);
  updateBusState(st);
  print.ok(`Permission set to: ${settings.PERMISSIONS[rest].label}`);
  if (rest === 'full') print.warn(t('perm_full_warning'));
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
    print.fail(`Directory not found: ${target}`);
    return;
  }
  if (!stat.isDirectory()) {
    print.fail(`Not a directory: ${target}`);
    return;
  }
  st.cwd = target;
  settings.setWorkspace(target);
  updateBusState(st);
  print.ok(`Workspace: ${target}`);
}

function handleLs(st, rest) {
  const target = rest ? path.resolve(st.cwd, rest) : st.cwd;
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    print.fail(`Cannot read ${target}：${err.code || err.message}`);
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
      print.hint(`No MCP servers. Use /mcp add or ${BIN} mcp add`);
      print.blank();
      return;
    }
    print.heading(`MCP Server（${list.length}）`);
    const rows = list.map((server, index) => [
      String(index + 1),
      server.name,
      server.status === 'running' ? COLORS.green('running') : server.status === 'error' ? COLORS.red('error') : 'stopped',
      server.pid ? String(server.pid) : '',
      `${server.command} ${(server.args || []).join(' ')}`
    ]);
    print.table(
      [
        { title: '#', max: 3 },
        { title: 'Name', max: 18 },
        { title: 'Status', max: 8 },
        { title: 'PID', max: 8 },
        { title: 'Command', max: 50 }
      ],
      rows
    );
    print.blank();
    print.hint('/mcp start <name> · /mcp stop <name> · /mcp logs <name> · /mcp add name command args');
    print.blank();
    return;
  }
  const server = mcp.findServer(arg);
  if (action === 'start') {
    if (!server) return print.fail(`MCP not found: ${arg}`);
    try {
      const result = mcp.startServer(server.id);
      print.ok(`Started ${server.name}（pid ${result.pid}）`);
    } catch (err) {
      print.fail(err.message);
    }
    return;
  }
  if (action === 'stop') {
    if (!server) return print.fail(`MCP not found: ${arg}`);
    mcp.stopServer(server.id);
    print.ok(`Stopped ${server.name}`);
    return;
  }
  if (action === 'logs') {
    if (!server) return print.fail(`MCP not found: ${arg}`);
    const logs = mcp.statusOf(server.id).logs || [];
    if (!logs.length) return print.hint('No logs yet');
    for (const entry of logs) {
      print.write(`${entry.stream === 'stderr' ? COLORS.red(entry.text) : entry.text}`);
    }
    return;
  }
  if (action === 'add') {
    const [name, command, ...args] = others;
    if (!name || !command) return print.fail('Usage: /mcp add <name> <command> [args...]');
    const created = mcp.addServer({ name, command, args });
    print.ok(`Added MCP "${created.name}" — start it with /mcp start ${created.name}`);
    return;
  }
  if (action === 'rm' || action === 'remove') {
    if (!server) return print.fail(`MCP not found: ${arg}`);
    mcp.removeServer(server.id);
    print.ok(`Deleted ${server.name}`);
    return;
  }
  print.fail(`Unknown /mcp action: ${action}`);
}

function handleTheme(rest) {
  const mode = String(rest || '').toLowerCase();
  if (mode === 'on' || mode === 'color') {
    setColorMode('ansi256');
    print.ok('Color output on');
    return;
  }
  if (mode === 'off' || mode === 'plain') {
    setColorMode('none');
    print.ok('Color output off');
    return;
  }
  print.write(`Color output: ${colorEnabled() ? 'on' : 'off'} (/theme on | off)`);
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
    print.fail('A prompt is required');
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
    print.warn('No provider configured yet');
    if (!process.stdin.isTTY) {
      print.hint('Run dgxay config init to set one up');
      return 1;
    }
    const result = await require('../commands/config').run({
      argv: ['init'],
      runtime: options
    });
    if (result !== 0) return result;
  }

  const st = createRuntime(options);
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  // 启动时先清屏，再渲染界面（管道模式不清屏，保持输出干净）
  if (interactive) {
    clearScreen(process.stdout);
    process.stdout.write('\x1b[3J');
  }

  // 历史：优先把当前会话里用户说过的话填进去，↑ 可以直接回填
  const previousPrompts = (st.chat?.messages || [])
    .filter((message) => message.role === 'user' && typeof message.content === 'string' && message.content.trim())
    .map((message) => message.content.trim());
  const lastUserPrompt = previousPrompts[previousPrompts.length - 1] || '';

  const editor = interactive
    ? new LineEditor({
        prompt: promptFor(st),
        placeholder: t('box_placeholder'),
        completer,
        multiline: true,
        capabilities: detectCapabilities(process.stdout),
        history: previousPrompts,
        lastUserPrompt
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
      process.stdout.write(`${COLORS.yellow(`${SIGN.bullet} ${t('interrupted')}`)}\n`);
      return true;
    }
    if (st.terminalBusy) return true;
    return false;
  });

  try {
    while (!st.exitRequested) {
      // 输入框上方的一行说明：模型 / 技能
      if (interactive) editor.prompt = promptFor(st);
      // ↑ 回填：始终指向最近一条用户提示词
      if (interactive) {
        const prompts = (st.chat?.messages || []).filter(
          (message) => message.role === 'user' && typeof message.content === 'string' && message.content.trim()
        );
        editor.lastUserPrompt = prompts.length ? prompts[prompts.length - 1].content.trim() : '';
        editor.history = prompts.map((message) => message.content.trim());
      }
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

  process.stdout.write(`${COLORS.faint(t('bye'))}\n`);
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
