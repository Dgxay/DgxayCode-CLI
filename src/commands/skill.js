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

const options = [{ name: 'json', type: 'boolean', desc: 'Output JSON' }];

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
    print.heading(`Skills (${settings.homeRelative(cfg.SKILLS_DIR)})`);
    if (!list.length) {
      print.hint('  No skills yet. Drop a name.md or <dir>/SKILL.md into the skills directory.');
      print.blank();
      return 0;
    }
    const rows = list.map((skill, index) => [String(index + 1), skill.name, skill.description, path.basename(skill.path)]);
    print.table(
      [
        { title: '#', max: 3 },
        { title: 'Name', max: 24 },
        { title: 'Description', max: 60 },
        { title: 'File', max: 24 }
      ],
      rows
    );
    print.blank();
    print.hint('Enable with /skill <name> in a conversation; for a single run add --skill <name>');
    print.blank();
    return 0;
  }

  if (action === 'show' || action === 'cat') {
    const name = rest[0];
    if (!name) throw Object.assign(new Error('Usage: dgxay skill show <name>'), { userError: true });
    const skill = skills.readSkill(name);
    if (!skill) {
      print.fail(`Skill not found: ${name}`);
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

  print.fail(`Unknown command: ${action}`);
  print.hint('Available: list / show / path');
  return 1;
}

module.exports = {
  name: 'skill',
  aliases: ['skills'],
  summary: 'List and view skills',
  usage: 'dgxay skill <list|show|path>',
  options,
  subcommands: [
    ['list', 'List skills'],
    ['show <name>', 'View skill content'],
    ['path', 'Show the skills directory']
  ],
  examples: ['dgxay skill list', 'dgxay skill show review', 'dgxay skill path'],
  run
};
