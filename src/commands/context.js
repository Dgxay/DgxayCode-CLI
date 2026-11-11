'use strict';

/**
 * context：查看某段会话的上下文估算用量（对应桌面版的上下文圆环）。
 */

const print = require('../cli/print');
const { actionFirst } = require('../cli/args');
const sessions = require('../core/sessions');
const settings = require('../services/settings');
const { contextInfo, contextReport } = require('../cli/ui');

const options = [];

async function run({ argv }) {
  const { action, rest } = actionFirst(argv, options);
  const ref = action || rest[0] || '';
  const config = settings.readConfig();
  const model = settings.activeModel(config);
  const chat = ref ? sessions.resolveChat(ref) : sessions.listChats()[0] || null;
  if (ref && !chat) {
    print.fail(`Conversation not found: ${ref}`);
    return 1;
  }
  if (!chat) {
    print.hint('No conversation history yet');
    return 0;
  }
  process.stdout.write(`\n${contextReport(contextInfo(chat, model))}\n`);
  print.hint(`Conversation: ${chat.title} (${chat.id})`);
  print.blank();
  return 0;
}

module.exports = {
  name: 'context',
  aliases: ['ctx'],
  summary: 'Show the estimated context usage',
  usage: 'dgxay context [n|id]',
  options,
  examples: ['dgxay context', 'dgxay context 1'],
  run
};
