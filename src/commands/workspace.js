'use strict';

/**
 * workspace：工作空间管理。
 *
 *   dgxay workspace             显示当前工作空间
 *   dgxay workspace set <目录>  设置工作空间（会记录到最近列表）
 *   dgxay workspace list        查看最近使用的工作空间
 *   dgxay workspace clear       清除工作空间
 */

const fs = require('fs');
const path = require('path');
const print = require('../cli/print');
const { parseArgs, actionFirst } = require('../cli/args');
const { COLORS } = require('../cli/ansi');
const settings = require('../services/settings');

const options = [{ name: 'both', alias: 'b', type: 'boolean', desc: 'Also persist to config (default only sets the current process)' }];

async function run({ argv }) {
  const { action, rest, options: opts } = actionFirst(argv, options);
  const config = settings.readConfig();

  if (!action || action === 'show' || action === 'current') {
    const workspace = config.work?.workspace || process.cwd();
    print.blank();
    print.keyValue([
      { label: 'Current workspace', value: workspace },
      { label: 'Process directory', value: process.cwd() },
      { label: 'Recent', value: (config.work?.recentWorkspaces || []).slice(0, 5).join('\n') || '(none)', multiline: true }
    ]);
    print.blank();
    print.hint('Set it with dgxay workspace set <dir>; inside a conversation use /cd');
    print.blank();
    return 0;
  }

  if (action === 'list' || action === 'ls') {
    const recents = config.work?.recentWorkspaces || [];
    print.blank();
    if (!recents.length) {
      print.hint('No workspace has been set yet');
      print.blank();
      return 0;
    }
    print.heading('Recent workspaces');
    recents.forEach((item, index) => {
      const exists = fs.existsSync(item) ? COLORS.green('✓') : COLORS.red('✗');
      print.write(`  ${status(index + 1)}  ${exists} ${item}`);
    });
    print.blank();
    return 0;
  }

  if (action === 'set' || action === 'use' || action === 'cd') {
    const target = rest[0] || '';
    if (!target) throw Object.assign(new Error('Usage: dgxay workspace set <dir>'), { userError: true });
    const resolved = path.resolve(target);
    try {
      if (!fs.statSync(resolved).isDirectory()) throw new Error('Not a directory');
    } catch {
      print.fail(`Directory not found: ${resolved}`);
      return 1;
    }
    settings.setWorkspace(resolved);
    print.ok(`Workspace: ${resolved}`);
    void opts;
    return 0;
  }

  if (action === 'clear' || action === 'unset') {
    settings.setWorkspace('');
    print.ok('Workspace cleared');
    return 0;
  }

  // 其他情况当作路径直接设置
  return run({ argv: ['set', action, ...rest] });
}

function status(index) {
  return COLORS.faint(String(index).padStart(2));
}

module.exports = {
  name: 'workspace',
  aliases: ['ws'],
  summary: 'Workspace management',
  usage: 'dgxay workspace [set|list|clear] [dir]',
  options,
  subcommands: [
    ['show', 'Show current workspace'],
    ['set <dir>', 'Set the workspace'],
    ['list', 'Show recent workspaces'],
    ['clear', 'Clear']
  ],
  examples: ['dgxay workspace set ./project', 'dgxay workspace list'],
  run
};
