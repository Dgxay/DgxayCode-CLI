'use strict';

/**
 * CLI 调度入口：全局选项 → 子命令分发 → 无参数时Start the interactive shell。
 */

const { COLORS } = require('./ansi');
const { parseArgs } = require('./args');
const { COMMANDS, findCommand } = require('./command-table');
const print = require('./print');
const { VERSION, BIN } = require('../services/version');

const GLOBAL_OPTIONS = [
  { name: 'help', alias: 'h', type: 'boolean', desc: 'Show help' },
  { name: 'version', alias: 'v', type: 'boolean', desc: 'Show version' },
  { name: 'home', type: 'string', valueName: 'dir', desc: 'Override the data directory (default ~/.dcb)' },
  { name: 'debug', type: 'boolean', desc: 'Print debug information and stack traces' },
  { name: 'no-color', type: 'boolean', desc: 'Disable colors (same as NO_COLOR=1)' },
  { name: 'print', alias: 'p', type: 'boolean', desc: 'One-shot: send a prompt, print the reply, exit' },
  { name: 'prompt', type: 'string', valueName: 'text', desc: 'Prompt for the one-shot run' },
  { name: 'output', alias: 'o', type: 'string', valueName: 'format', desc: 'Output format: text / json' },
  { name: 'mode', alias: 'm', type: 'string', valueName: 'mode', desc: 'Mode: chat / work' },
  { name: 'permission', type: 'string', valueName: 'level', desc: 'Permission: none / normal / auto / full' },
  { name: 'workspace', alias: 'C', type: 'string', valueName: 'dir', desc: 'Workspace directory' },
  { name: 'model', type: 'string', valueName: 'id', desc: 'Model id' },
  { name: 'provider', type: 'string', valueName: 'name', desc: 'Provider id or name' },
  { name: 'skill', type: 'string', valueName: 'name', desc: 'Skill to enable for this run' },
  { name: 'resume', alias: 'r', type: 'string', valueName: 'id|index', desc: 'Resume a conversation by index or id' },
  { name: 'continue', alias: 'c', type: 'boolean', desc: 'Resume the most recent conversation' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: 'Auto-approve all permission requests (one-shot only)' }
];

const LOGO = [
  '  ██████╗  ██████╗ ██╗  ██╗ █████╗ ██╗   ██╗',
  '  ██╔══██╗██╔════╝ ╚██╗██╔╝██╔══██╗╚██╗ ██╔╝',
  '  ██║  ██║██║  ███╗ ╚███╔╝ ███████║ ╚████╔╝ ',
  '  ██║  ██║██║   ██║ ██╔██╗ ██╔══██║  ╚██╔╝  ',
  '  ██████╔╝╚██████╔╝██╔╝ ██╗██║  ██║   ██║   ',
  '  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   '
];

function showBanner() {
  for (const line of LOGO) process.stdout.write(`${COLORS.accent(line)}\n`);
  process.stdout.write(
    `${COLORS.faint(`  v${VERSION} · multi-protocol AI coding assistant · /help for commands · Ctrl+C to exit`)}\n\n`
  );
}

function showHelp() {
  process.stdout.write(`\n${COLORS.bold(`${BIN} — DgxayCode CLI`)} ${COLORS.faint(`v${VERSION}`)}\n\n`);
  process.stdout.write(`${COLORS.faint('Usage')}\n  ${BIN} [options] [command] [args...]\n\n`);
  process.stdout.write(`${COLORS.faint('Quick start')}\n`);
  const rows = [
    [`${BIN}`, 'Start the interactive shell'],
    [`${BIN} "write a python script"`, 'Ask once and exit'],
    [`${BIN} run -p "..." -C ./project`, 'One-shot with a workspace'],
    [`${BIN} config init`, 'First-time setup (provider + API key)'],
    [`${BIN} doctor`, 'Self-check: config, paths, connectivity'],
    [`${BIN} <command> --help`, 'Show detailed usage for a command']
  ];
  const width = Math.max(...rows.map(([cmd]) => cmd.length));
  for (const [cmd, desc] of rows) {
    process.stdout.write(`  ${COLORS.cyan(cmd.padEnd(width))}  ${COLORS.faint(desc)}\n`);
  }
  process.stdout.write(`\n${COLORS.faint('Commands')}\n`);
  const nameWidth = Math.max(...COMMANDS.map((cmd) => cmd.name.length));
  for (const cmd of COMMANDS) {
    const aliases = cmd.aliases?.length ? COLORS.faint(` (${cmd.aliases.join(', ')})`) : '';
    process.stdout.write(`  ${COLORS.accent(cmd.name.padEnd(nameWidth))}  ${cmd.summary || ''}${aliases}\n`);
  }
  process.stdout.write(`\n${COLORS.faint('Global options')}\n`);
  const flags = GLOBAL_OPTIONS.map((opt) => {
    const alias = opt.alias ? `-${opt.alias}, ` : '    ';
    const value = opt.type !== 'boolean' ? ` <${opt.valueName || opt.type}>` : '';
    return [`${alias}--${opt.name}${value}`, opt.desc];
  });
  const flagWidth = Math.max(...flags.map(([flag]) => flag.length));
  for (const [flag, desc] of flags) {
    process.stdout.write(`  ${COLORS.cyan(flag.padEnd(flagWidth))}  ${COLORS.faint(desc)}\n`);
  }
  process.stdout.write(
    `\n${COLORS.faint('Notes')} Configuration and conversations live in ${COLORS.faint('~/.dcb')} (override with DGXAY_HOME). Run ${COLORS.faint(
      `${BIN} config path`
    )}  to see the paths.\n\n`
  );
}

/** 把全局选项转成运行参数 */
function runtimeOptions(options) {
  return {
    mode: options.mode,
    permission: options.permission,
    workspace: options.workspace,
    model: options.model,
    provider: options.provider,
    skill: options.skill,
    resume: options.resume,
    continueLast: options.continue,
    yes: options.yes,
    output: options.output || 'text',
    print: Boolean(options.print || options.prompt)
  };
}

/** --home 必须在读取配置前生效：去掉该参数后重新进入 main */
function extractHome(argv) {
  const args = argv.slice();
  let home = null;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--home') {
      if (args[i + 1]) {
        home = args[i + 1];
        args.splice(i, 2);
        return { args, home };
      }
      args.splice(i, 1);
      return { args, home };
    }
    if (token.startsWith('--home=')) {
      home = token.slice('--home='.length);
      args.splice(i, 1);
      return { args, home };
    }
  }
  return { args, home };
}

/** 清掉本项目模块的缓存，让 config.js 用新的 DGXAY_HOME 重新计算数据目录 */
function resetModuleCache() {
  process.env.DGXAY_HOME = process.env.DGXAY_HOME || '';
  if (!process.env.DGXAY_HOME) delete process.env.DGXAY_HOME;
  const sep = require('path').sep;
  const root = require('path').join(__dirname, '..');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(root) && !key.includes(`${sep}bin${sep}`)) delete require.cache[key];
  }
}

async function main(argv) {
  let args = Array.isArray(argv) ? argv.slice() : [];

  const extracted = extractHome(args);
  if (extracted.home !== null) {
    process.env.DGXAY_HOME = extracted.home;
    args = extracted.args;
    resetModuleCache();
  }

  let parsed;
  try {
    parsed = parseArgs(args, GLOBAL_OPTIONS.map((opt) => ({ ...opt })), { allowUnknown: true });
  } catch (err) {
    print.fail(err.message);
    return 2;
  }

  if (parsed.options.noColor) process.env.NO_COLOR = '1';
  if (parsed.options.debug) process.env.DGXAY_DEBUG = '1';

  if (parsed.options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const commandName = parsed.positionals[0];
  const command = commandName ? findCommand(commandName) : null;

  // 只有命令 token 本身放在位置参数里；它后面的全部原始参数原样交给子命令，
  // 否则子命令自己的选项（如 provider add --model）会被全局解析器吞掉。
  const commandIndex = commandName ? args.lastIndexOf(commandName) : -1;
  const commandArgv = command ? args.slice(commandIndex + 1) : [];

  if (parsed.options.help && !command) {
    showHelp();
    return 0;
  }

  const runtime = runtimeOptions(parsed.options);

  if (command) {
    if (parsed.options.help) {
      print.usage(command);
      return 0;
    }
    try {
      const result = await command.run({
        argv: commandArgv,
        globalOptions: parsed.options,
        runtime,
        io: { command }
      });
      return typeof result === 'number' ? result : 0;
    } catch (err) {
      if (err?.userError) {
        print.fail(err.message);
        print.hint(`Run ${BIN} ${command.name} --help for usage`);
        return 2;
      }
      print.fail(err?.message || String(err));
      if (process.env.DGXAY_DEBUG === '1' && err?.stack) process.stderr.write(`${err.stack}\n`);
      return 1;
    }
  }

  // 不是子命令：整串参数当作单次运行的提示词；否则Start the interactive shell
  const prompt = parsed.positionals.join(' ').trim();
  const repl = require('./repl');
  try {
    return await repl.start({
      ...runtime,
      initialPrompt: prompt,
      // 只有显式给了提示词或 --print 才是单次运行；
      // 用 -c / -r 指定会话但没有提示词时，仍是交互模式（恢复会话后继续输入）
      single: Boolean(prompt) || Boolean(runtime.print)
    });
  } catch (err) {
    if (err?.userError) {
      print.fail(err.message);
      return 2;
    }
    print.fail(err?.message || String(err));
    if (process.env.DGXAY_DEBUG === '1' && err?.stack) process.stderr.write(`${err.stack}\n`);
    return 1;
  }
}

module.exports = { main, GLOBAL_OPTIONS, showHelp, showBanner, LOGO };
