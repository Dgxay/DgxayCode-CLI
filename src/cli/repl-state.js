'use strict';

/**
 * REPL 的运行时状态。
 * 配置以「每次操作重新读取」为主，但 UI 模式 / 权限 / 工作空间 / 模型在会话内可临时覆盖，
 * 用 overrides 表示；用 cfg.patchConfig() 持久化修改后再刷新覆盖值。
 */

const path = require('path');
const os = require('os');

function createState() {
  return {
    cwd: process.cwd(),
    overrides: {},
    runtime: {
      mode: 'chat',
      permission: 'normal',
      providerId: '',
      modelId: '',
      skill: ''
    },
    chat: null,
    streaming: false,
    abortRequested: false,
    terminalBusy: false,
    requestController: null,
    lastResponse: null,
    pendingInsert: ''
  };
}

function recentWorkspaces(config) {
  const list = config?.work?.recentWorkspaces || [];
  return list.filter((item) => typeof item === 'string' && item.trim());
}

function activeProvider(config) {
  const providers = config?.providers || [];
  return providers.find((p) => p.id === config?.activeProviderId) || providers[0] || null;
}

function activeModel(config) {
  const provider = activeProvider(config);
  if (!provider) return null;
  const models = provider.models || [];
  const model = models.find((m) => m.id === config?.activeModelId) || models[0];
  if (!model) return null;
  return {
    id: model.id,
    name: model.name || model.id,
    providerId: provider.id,
    providerName: provider.name,
    protocol: provider.protocol || 'openai',
    contextWindow: Number(model.contextWindow) || 0,
    reviewModelId: provider.reviewModelId || ''
  };
}

function workspaceOf(state, config) {
  return state.cwd || config?.work?.workspace || os.homedir();
}

function workspaceLabel(workspace) {
  if (!workspace) return '未选择';
  const parts = String(workspace)
    .split(/[\\/]/)
    .filter(Boolean);
  return parts[parts.length - 1] || workspace;
}

function relativePath(base, target) {
  const rel = path.relative(base, target);
  return rel === '' ? '.' : rel;
}

module.exports = {
  createState,
  recentWorkspaces,
  activeProvider,
  activeModel,
  workspaceOf,
  workspaceLabel,
  relativePath
};
