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
  print.heading('Permission');
  for (const [key, meta] of Object.entries(settings.PERMISSIONS)) {
    const usable = available.includes(key);
    const active = current === key;
    print.write(
      `  ${active ? COLORS.accent('❯') : ' '} ${COLORS.accent(key.padEnd(8))} ${usable ? meta.label : COLORS.faint(`${meta.label} (unavailable)`)}`
    );
    print.write(`    ${COLORS.faint(meta.desc)}`);
  }
  print.blank();
  if (reviewer) {
    print.hint(`Review model: ${reviewer.provider.name} / ${reviewer.modelId} (from: ${reviewer.source === 'own' ? 'current provider' : 'default provider'})`);
  } else {
    print.hint('No review model configured, so auto review is unavailable. Set one with dgxay provider review <provider> --model <model-id>');
  }
  if (config.ui?.permission === 'auto' && !available.includes('auto')) {
    print.warn('Auto review from config is no longer valid; running with normal permission');
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
    if (!level) throw Object.assign(new Error('Usage: dgxay permission set <none|normal|auto|full>'), { userError: true });
    if (!settings.PERMISSIONS[level]) {
      print.fail('Permission must be one of none / normal / auto / full');
      return 1;
    }
    if (level === 'auto' && !settings.hasReviewModel(config)) {
      print.fail('Auto review unavailable: neither the current nor the default provider has a valid review model');
      print.hint('Run first: dgxay provider review <provider> --model <model-id>');
      return 1;
    }
    settings.setPermission(level);
    print.ok(`Permission set to: ${settings.PERMISSIONS[level].label}`);
    if (level === 'full') {
      print.warn('With full access the AI can run any command and read or write any file without asking');
    }
    void runtime;
    return 0;
  }

  if (settings.PERMISSIONS[action]) {
    const level = action;
    if (level === 'auto' && !settings.hasReviewModel(config)) {
      print.fail('Auto review unavailable: configure a review model first');
      return 1;
    }
    settings.setPermission(level);
    print.ok(`Permission set to: ${settings.PERMISSIONS[level].label}`);
    return 0;
  }

  print.fail(`Unknown usage: ${action}`);
  print.hint('Available: list / set <level>');
  return 1;
}

module.exports = {
  name: 'permission',
  aliases: ['perm'],
  summary: 'Four permission levels: show and switch',
  usage: 'dgxay permission [list|show|set <level>]',
  options,
  subcommands: [
    ['list', 'Show permissions and availability'],
    ['set <level>', 'Switch permission (writes config)']
  ],
  examples: ['dgxay permission', 'dgxay permission set normal', 'dgxay permission set auto'],
  run
};
