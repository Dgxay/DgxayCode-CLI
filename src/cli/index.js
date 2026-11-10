'use strict';

/**
 * CLI 调度入口：全局选项 → 子命令分发 → 无参数时进入交互模式。
 */

const { COLORS } = require('./ansi');
const { parseArgs } = require('./args');
const { COMMANDS, findCommand } = require('./command-table');
const print = require('./print');
const { VERSION, BIN } = require('../services/version');

const GLOBAL_OPTIONS = [
  { name: 'help', alias: 'h', type: 'boolean', desc: '显示帮助' },
  { name: 'version', alias: 'v', type: 'boolean', desc: '显示版本号' },
  { name: 'home', type: 'string', valueName: 'dir', desc: '覆盖数据目录（默认 ~/.dcb，也可用 DGXAY_HOME）' },
  { name: 'debug', type: 'boolean', desc: '输出调试信息与堆栈' },
  { name: 'no-color', type: 'boolean', desc: '关闭彩色输出（等同 NO_COLOR=1）' },
  { name: 'print', alias: 'p', type: 'boolean', desc: '单次运行：发送提示词后输出结果并退出' },
  { name: 'prompt', type: 'string', valueName: 'text', desc: '单次运行的提示词' },
  { name: 'output', alias: 'o', type: 'string', valueName: 'format', desc: '输出格式：text / json（配合 --print）' },
  { name: 'mode', alias: 'm', type: 'string', valueName: 'mode', desc: '模式：chat / work' },
  { name: 'permission', type: 'string', valueName: 'level', desc: '权限：none / normal / auto / full' },
  { name: 'workspace', alias: 'C', type: 'string', valueName: 'dir', desc: '工作空间目录' },
  { name: 'model', type: 'string', valueName: 'id', desc: '指定模型' },
  { name: 'provider', type: 'string', valueName: 'name', desc: '指定供应商' },
  { name: 'skill', type: 'string', valueName: 'name', desc: '本次运行启用的技能' },
  { name: 'resume', alias: 'r', type: 'string', valueName: 'id|index', desc: '恢复指定会话' },
  { name: 'continue', alias: 'c', type: 'boolean', desc: '恢复最近一次会话' },
  { name: 'yes', alias: 'y', type: 'boolean', desc: '自动同意所有授权请求（仅单次运行，慎用）' }
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
    `${COLORS.faint(`  v${VERSION} · 多协议 AI 编码助手 · 输入 /help 查看命令 · Ctrl+C 退出`)}\n\n`
  );
}

function showHelp() {
  process.stdout.write(`\n${COLORS.bold(`${BIN} — DgxayCode 命令行版`)} ${COLORS.faint(`v${VERSION}`)}\n\n`);
  process.stdout.write(`${COLORS.faint('用法')}\n  ${BIN} [选项] [命令] [参数…]\n\n`);
  process.stdout.write(`${COLORS.faint('常用命令')}\n`);
  const rows = [
    [`${BIN}`, '进入交互模式'],
    [`${BIN} "帮我写一个 Python 脚本"`, '单次执行后退出'],
    [`${BIN} run -p "..." -C ./project`, '指定工作空间单次执行'],
    [`${BIN} config init`, '首次配置（填写供应商与 API Key）'],
    [`${BIN} doctor`, '自检：配置、目录、模型连通性'],
    [`${BIN} <命令> --help`, '查看某个命令的详细用法']
  ];
  const width = Math.max(...rows.map(([cmd]) => cmd.length));
  for (const [cmd, desc] of rows) {
    process.stdout.write(`  ${COLORS.cyan(cmd.padEnd(width))}  ${COLORS.faint(desc)}\n`);
  }
  process.stdout.write(`\n${COLORS.faint('子命令')}\n`);
  const nameWidth = Math.max(...COMMANDS.map((cmd) => cmd.name.length));
  for (const cmd of COMMANDS) {
    const aliases = cmd.aliases?.length ? COLORS.faint(` (${cmd.aliases.join(', ')})`) : '';
    process.stdout.write(`  ${COLORS.accent(cmd.name.padEnd(nameWidth))}  ${cmd.summary || ''}${aliases}\n`);
  }
  process.stdout.write(`\n${COLORS.faint('全局选项')}\n`);
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
    `\n${COLORS.faint('说明')} 配置与对话保存在 ${COLORS.faint('~/.dcb')}（可用 DGXAY_HOME 覆盖），可用 ${COLORS.faint(
      `${BIN} config path`
    )} 查看。\n\n`
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
        print.hint(`运行 ${BIN} ${command.name} --help 查看用法`);
        return 2;
      }
      print.fail(err?.message || String(err));
      if (process.env.DGXAY_DEBUG === '1' && err?.stack) process.stderr.write(`${err.stack}\n`);
      return 1;
    }
  }

  // 不是子命令：整串参数当作单次运行的提示词；否则进入交互模式
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
