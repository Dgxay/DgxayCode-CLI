'use strict';

/**
 * skill：技能列表（对应桌面版「/技能」）。
 *
 *   dgxay skill list        列出 ~/.dcb/skills 下的技能
 *   dgxay skill show <名称> 查看技能正文
 *   dgxay skill path        显示技能目录
 */

const fs = require('fs');
const path = require('path');
const print = require('../cli/print');
const { parseArgs, actionFirst } = require('../cli/args');
const skills = require('../services/skills');
const cfg = require('../services/config');
const settings = require('../services/settings');

const options = [{ name: 'json', type: 'boolean', desc: '输出 JSON' }];

async function run({ argv }) {
  const { action: rawAction, rest, options: opts } = actionFirst(argv, options);
  const action = rawAction || 'list';

  if (action === 'path') {
    print.write(cfg.SKILLS_DIR);
    return 0;
  }

  if (action === 'list' || action === 'ls') {
    const list = skills.listSkills();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      return 0;
    }
    print.blank();
    print.heading(`技能（${settings.homeRelative(cfg.SKILLS_DIR)}）`);
    if (!list.length) {
      print.hint('  还没有技能。放一个 name.md 或 <目录>/SKILL.md 到技能目录即可。');
      print.blank();
      return 0;
    }
    const rows = list.map((skill, index) => [String(index + 1), skill.name, skill.description, path.basename(skill.path)]);
    print.table(
      [
        { title: '#', max: 3 },
        { title: '名称', max: 24 },
        { title: '描述', max: 60 },
        { title: '文件', max: 24 }
      ],
      rows
    );
    print.blank();
    print.hint('在对话中使用 /skill <名称> 启用；单次运行可加 --skill <名称>');
    print.blank();
    return 0;
  }

  if (action === 'show' || action === 'cat') {
    const name = rest[0];
    if (!name) throw Object.assign(new Error('用法：dgxay skill show <名称>'), { userError: true });
    const skill = skills.readSkill(name);
    if (!skill) {
      print.fail(`找不到技能：${name}`);
      return 1;
    }
    print.blank();
    print.heading(`${skill.name}`);
    print.hint(skill.path);
    print.blank();
    print.write(skill.content);
    print.blank();
    return 0;
  }

  print.fail(`未知子命令：${action}`);
  print.hint('可用：list / show / path');
  return 1;
}

module.exports = {
  name: 'skill',
  aliases: ['skills'],
  summary: '技能列表与查看',
  usage: 'dgxay skill <list|show|path>',
  options,
  subcommands: [
    ['list', '列出技能'],
    ['show <名称>', '查看技能正文'],
    ['path', '显示技能目录']
  ],
  examples: ['dgxay skill list', 'dgxay skill show review', 'dgxay skill path'],
  run
};
