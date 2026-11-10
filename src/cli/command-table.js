'use strict';

/**
 * 子命令注册表。每个命令：{ name, aliases, summary, usage, options, run(ctx) }
 * ctx = { argv, io, config, print, error, exitCode }
 */

const chat = require('../commands/chat');
const config = require('../commands/config');
const provider = require('../commands/provider');
const model = require('../commands/model');
const oauth = require('../commands/oauth');
const mcp = require('../commands/mcp');
const skill = require('../commands/skill');
const workspace = require('../commands/workspace');
const permission = require('../commands/permission');
const context = require('../commands/context');
const run = require('../commands/run');
const exportCmd = require('../commands/export');
const doctor = require('../commands/doctor');

const COMMANDS = [
  run,
  chat,
  config,
  provider,
  model,
  oauth,
  mcp,
  skill,
  workspace,
  permission,
  context,
  exportCmd,
  doctor
];

function findCommand(name) {
  const target = String(name || '').toLowerCase();
  return (
    COMMANDS.find((cmd) => cmd.name === target) ||
    COMMANDS.find((cmd) => (cmd.aliases || []).includes(target)) ||
    null
  );
}

/** 汇总所有子命令的选项（用于全局解析后分发给命令自身） */
function specFor(command) {
  return command?.options || [];
}

module.exports = { COMMANDS, findCommand, specFor };
