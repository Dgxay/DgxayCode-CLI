'use strict';

/**
 * permission：四档权限（对应桌面版权限列表）。
 *
 *   dgxay permission          查看当前权限与可用性
 *   dgxay permission list     同上（带说明）
 *   dgxay permission set auto 切换权限并写入配置
 *
 * 自动审查只有在「当前供应商或默认供应商」配置了有效审查模型时才可用；
 * 移除审查模型后自动回落到普通权限。
 */

const print = require('../cli/print');
const { actionFirst } = require('../cli/args');
const { COLORS } = require('../cli/ansi');
const settings = require('../services/settings');
const { resolveReviewer } = require('../core/prompt');

const options = [];

function overview() {
  const config = settings.readConfig();
  const current = settings.currentPermission(config);
  const available = settings.availablePermissions(config);
  const reviewer = resolveReviewer(config, config.activeProviderId);
  print.blank();
  print.heading('权限');
  for (const [key, meta] of Object.entries(settings.PERMISSIONS)) {
    const usable = available.includes(key);
    const active = current === key;
    print.write(
      `  ${active ? COLORS.accent('❯') : ' '} ${COLORS.accent(key.padEnd(8))} ${usable ? meta.label : COLORS.faint(`${meta.label}（不可用）`)}`
    );
    print.write(`    ${COLORS.faint(meta.desc)}`);
  }
  print.blank();
  if (reviewer) {
    print.hint(`自动审查模型：${reviewer.provider.name} / ${reviewer.modelId}（来源：${reviewer.source === 'own' ? '当前供应商' : '默认供应商'}）`);
  } else {
    print.hint('尚未配置审查模型，自动审查不可用。用 dgxay provider review <供应商> --model <模型ID> 设置');
  }
  if (config.ui?.permission === 'auto' && !available.includes('auto')) {
    print.warn('配置里的自动审查已失效，当前按普通权限运行');
  }
  print.blank();
  print.hint('dgxay permission set <none|normal|auto|full>');
  print.blank();
  return 0;
}

async function run({ argv, runtime }) {
  const { action: rawAction, rest } = actionFirst(argv, options);
  const action = rawAction || 'list';
  const config = settings.readConfig();

  if (action === 'list' || action === 'show') return overview();

  if (action === 'set' || action === 'use') {
    const level = rest[0];
    if (!level) throw Object.assign(new Error('用法：dgxay permission set <none|normal|auto|full>'), { userError: true });
    if (!settings.PERMISSIONS[level]) {
      print.fail('权限只能是 none / normal / auto / full');
      return 1;
    }
    if (level === 'auto' && !settings.hasReviewModel(config)) {
      print.fail('自动审查不可用：当前或默认供应商没有配置有效的审查模型');
      print.hint('先运行：dgxay provider review <供应商> --model <模型ID>');
      return 1;
    }
    settings.setPermission(level);
    print.ok(`权限已设置为：${settings.PERMISSIONS[level].label}`);
    if (level === 'full') {
      print.warn('完全权限下 AI 可以执行任意命令、读写任意文件，且不会询问');
    }
    void runtime;
    return 0;
  }

  if (settings.PERMISSIONS[action]) {
    const level = action;
    if (level === 'auto' && !settings.hasReviewModel(config)) {
      print.fail('自动审查不可用：请先配置审查模型');
      return 1;
    }
    settings.setPermission(level);
    print.ok(`权限已设置为：${settings.PERMISSIONS[level].label}`);
    return 0;
  }

  print.fail(`未知用法：${action}`);
  print.hint('可用：list / set <档位>');
  return 1;
}

module.exports = {
  name: 'permission',
  aliases: ['perm'],
  summary: '四档权限：查看与切换',
  usage: 'dgxay permission [list|show|set <档位>]',
  options,
  subcommands: [
    ['list', '查看权限与可用性'],
    ['set <档位>', '切换权限（写入配置）']
  ],
  examples: ['dgxay permission', 'dgxay permission set normal', 'dgxay permission set auto'],
  run
};
