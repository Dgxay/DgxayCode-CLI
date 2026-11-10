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

const options = [{ name: 'both', alias: 'b', type: 'boolean', desc: '同时写入配置（默认只设当前进程）' }];

async function run({ argv }) {
  const { action, rest, options: opts } = actionFirst(argv, options);
  const config = settings.readConfig();

  if (!action || action === 'show' || action === 'current') {
    const workspace = config.work?.workspace || process.cwd();
    print.blank();
    print.keyValue([
      { label: '当前工作空间', value: workspace },
      { label: '进程目录', value: process.cwd() },
      { label: '最近使用', value: (config.work?.recentWorkspaces || []).slice(0, 5).join('\n') || '（无）', multiline: true }
    ]);
    print.blank();
    print.hint('dgxay workspace set <目录> 设置；对话中可用 /cd');
    print.blank();
    return 0;
  }

  if (action === 'list' || action === 'ls') {
    const recents = config.work?.recentWorkspaces || [];
    print.blank();
    if (!recents.length) {
      print.hint('还没有设置过工作空间');
      print.blank();
      return 0;
    }
    print.heading('最近使用的工作空间');
    recents.forEach((item, index) => {
      const exists = fs.existsSync(item) ? COLORS.green('✓') : COLORS.red('✗');
      print.write(`  ${status(index + 1)}  ${exists} ${item}`);
    });
    print.blank();
    return 0;
  }

  if (action === 'set' || action === 'use' || action === 'cd') {
    const target = rest[0] || '';
    if (!target) throw Object.assign(new Error('用法：dgxay workspace set <目录>'), { userError: true });
    const resolved = path.resolve(target);
    try {
      if (!fs.statSync(resolved).isDirectory()) throw new Error('不是文件夹');
    } catch {
      print.fail(`目录不存在：${resolved}`);
      return 1;
    }
    settings.setWorkspace(resolved);
    print.ok(`工作空间：${resolved}`);
    void opts;
    return 0;
  }

  if (action === 'clear' || action === 'unset') {
    settings.setWorkspace('');
    print.ok('已清除工作空间');
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
  summary: '工作空间管理',
  usage: 'dgxay workspace [set|list|clear] [目录]',
  options,
  subcommands: [
    ['show', '显示当前工作空间'],
    ['set <目录>', '设置工作空间'],
    ['list', '查看最近使用'],
    ['clear', '清除']
  ],
  examples: ['dgxay workspace set ./project', 'dgxay workspace list'],
  run
};
