'use strict';

/** 子命令之间共享的小工具。 */

const sessions = require('../core/sessions');

function resolveChatArg(opts = {}, runtime = {}) {
  if (opts.resume || runtime.resume) return sessions.getChat(String(opts.resume || runtime.resume));
  if (opts.continue || runtime.continueLast) return sessions.listChats()[0] || null;
  return null;
}

/** 失败时给出“下一步”提示而不是直接抛错 */
function requireProviders(config) {
  if (!config.providers?.length) {
    throw Object.assign(new Error('还没有配置供应商。运行 dgxay config init 开始配置'), { userError: true });
  }
}

module.exports = { resolveChatArg, requireProviders };
