'use strict';

/**
 * 配置操作层：供应商 / 模型 / 权限 / 首选项的读写，供子命令与 REPL 共用。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('../services/config');
const oauth = require('../core/oauth');
const { PROTOCOLS } = require('../core/llm');
const { resolveReviewer, resolveProviderAuth } = require('../core/prompt');
const { listModels } = require('../core/llm');

const PERMISSIONS = {
  none: {
    label: 'No permission',
    short: 'read-only',
    desc: 'Read-only access inside the workspace'
  },
  normal: {
    label: 'Normal',
    short: 'normal',
    desc: 'All capabilities, but every operation asks you'
  },
  auto: {
    label: 'Auto review',
    short: 'auto',
    desc: 'All capabilities; a reviewer model decides, suspicious ones ask you'
  },
  full: {
    label: 'Full access',
    short: 'full',
    desc: 'Run commands, touch any file, unrestricted network'
  }
};

const PROTOCOL_META = {
  openai: {
    short: 'ChatCompletions',
    full: 'OpenAI ChatCompletions',
    path: '/v1/chat/completions',
    basePlaceholder: 'https://api.openai.com/v1',
    modelPlaceholder: 'e.g. gpt-4o, deepseek-chat'
  },
  anthropic: {
    short: 'Messages',
    full: 'Anthropic Messages',
    path: '/v1/messages',
    basePlaceholder: 'https://api.anthropic.com',
    modelPlaceholder: 'e.g. claude-sonnet-4-5'
  },
  responses: {
    short: 'Responses',
    full: 'OpenAI Responses API',
    path: '/v1/responses',
    basePlaceholder: 'https://api.openai.com/v1',
    modelPlaceholder: 'e.g. gpt-5, o4-mini'
  }
};

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function readConfig() {
  return cfg.readConfig();
}

function saveConfig(patch) {
  return cfg.saveConfig(patch || {});
}

function providers() {
  return cfg.readConfig().providers || [];
}

function findProvider(ref) {
  if (!ref) return null;
  const list = providers();
  const text = String(ref).trim();
  return (
    list.find((p) => p.id === text) ||
    list.find((p) => String(p.name).toLowerCase() === text.toLowerCase()) ||
    null
  );
}

function activeProvider(config = readConfig()) {
  const list = config.providers || [];
  return list.find((p) => p.id === config.activeProviderId) || list[0] || null;
}

function activeModel(config = readConfig()) {
  const provider = activeProvider(config);
  if (!provider) return null;
  const models = provider.models || [];
  const model = models.find((m) => m.id === config.activeModelId) || models[0];
  if (!model) return null;
  return {
    id: model.id,
    name: model.name || model.id,
    providerId: provider.id,
    providerName: provider.name,
    protocol: provider.protocol || 'openai',
    contextWindow: Number(model.contextWindow) || 0
  };
}

function availablePermissions(config = readConfig()) {
  const list = ['none', 'normal'];
  if (resolveReviewer(config, config.activeProviderId)) list.push('auto');
  list.push('full');
  return list;
}

function hasReviewModel(config = readConfig()) {
  return Boolean(resolveReviewer(config, config.activeProviderId));
}

function currentPermission(config = readConfig()) {
  const value = config.ui?.permission || 'normal';
  if (value === 'auto' && !hasReviewModel(config)) return 'normal';
  return PERMISSIONS[value] ? value : 'normal';
}

function currentMode(config = readConfig()) {
  return config.ui?.mode === 'work' ? 'work' : 'chat';
}

/**
 * 新增或修改供应商。
 * @param {object} input { ref, name, protocol, baseUrl, apiKey, authMode, oauthProvider, reviewModelId, models }
 */
function upsertProvider(input = {}) {
  const config = readConfig();
  const list = config.providers || [];
  const existing = input.ref ? findProvider(input.ref) : null;
  if (input.ref && !existing) throw new Error(`Provider not found: ${input.ref}`);

  const protocol = PROTOCOLS.includes(input.protocol) ? input.protocol : existing?.protocol || 'openai';
  const baseUrl = String(input.baseUrl || existing?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL must start with http:// or https://');

  const models = normalizeModels(input.models, existing?.models);
  if (!models.length) throw new Error('Provide at least one model id (--model)');

  const authMode = input.authMode === 'oauth' ? 'oauth' : 'apiKey';
  const oauthProvider = authMode === 'oauth' ? String(input.oauthProvider || '').trim() : '';
  if (authMode === 'oauth') {
    if (!oauthProvider) throw new Error('Pass --oauth-provider (openai/anthropic/xai/google) to use an OAuth account');
    const account = oauth.listProviders().find((item) => item.id === oauthProvider);
    if (!account?.connection || account.connection.expired) {
      throw new Error(`${oauthProvider} is not connected or the login expired. Run dgxay oauth connect ${oauthProvider}`);
    }
  }

  const record = {
    id: existing?.id || newId('prov'),
    name: String(input.name || existing?.name || 'My provider').trim(),
    protocol,
    baseUrl,
    apiKey: input.apiKey !== undefined ? String(input.apiKey) : existing?.apiKey || '',
    authMode,
    oauthProvider,
    reviewModelId:
      input.reviewModelId !== undefined
        ? String(input.reviewModelId || '')
        : existing?.reviewModelId || models[0].id,
    models
  };
  if (!models.some((m) => m.id === record.reviewModelId)) record.reviewModelId = models[0].id;

  const next = list.map((p) => (p.id === record.id ? { ...p, ...record } : p));
  if (!existing) next.push(record);

  const patch = { providers: next };
  if (!config.activeProviderId || existing?.id === config.activeProviderId) {
    patch.activeProviderId = record.id;
    const stillValid = models.find((m) => m.id === config.activeModelId);
    if (existing?.id !== config.activeProviderId || !stillValid) patch.activeModelId = record.reviewModelId;
  }
  return { provider: record, config: saveConfig(patch), created: !existing };
}

function normalizeModels(input, fallback = []) {
  let list = input;
  if (typeof list === 'string') list = list.split(',').map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(list) || !list.length) {
    list = (fallback || []).map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow }));
  }
  const out = [];
  for (const item of list) {
    const model =
      typeof item === 'string' ? { id: item } : { id: item?.id, name: item?.name, contextWindow: item?.contextWindow };
    const id = String(model.id || '').trim();
    if (!id) continue;
    if (out.find((m) => m.id === id)) continue;
    out.push({ id, name: String(model.name || id).trim(), contextWindow: Number(model.contextWindow) || 0 });
  }
  return out;
}

function removeProvider(ref) {
  const config = readConfig();
  const target = findProvider(ref);
  if (!target) throw new Error(`Provider not found: ${ref}`);
  const next = (config.providers || []).filter((p) => p.id !== target.id);
  const patch = { providers: next };
  if (config.activeProviderId === target.id) {
    patch.activeProviderId = next[0]?.id || '';
    patch.activeModelId = next[0]?.models?.[0]?.id || '';
  }
  return saveConfig(patch);
}

function moveProvider(ref, direction) {
  const config = readConfig();
  const list = (config.providers || []).slice();
  const target = findProvider(ref);
  if (!target) throw new Error(`Provider not found: ${ref}`);
  const index = list.findIndex((p) => p.id === target.id);
  const nextIndex = direction < 0 ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= list.length) return config;
  const [item] = list.splice(index, 1);
  list.splice(nextIndex, 0, item);
  return saveConfig({ providers: list });
}

function setActiveModel(providerRef, modelRef) {
  const config = readConfig();
  const provider = providerRef ? findProvider(providerRef) : activeProvider(config);
  if (!provider) throw new Error('No provider available');
  const models = provider.models || [];
  const model = models.find((m) => m.id === modelRef) || models.find((m) => m.id.includes(String(modelRef)));
  if (!model) throw new Error(`Provider ${provider.name} has no model ${modelRef}`);
  return saveConfig({ activeProviderId: provider.id, activeModelId: model.id });
}

function setPermission(permission) {
  if (!PERMISSIONS[permission]) throw new Error(`Unknown permission: ${permission}`);
  return saveConfig({ ui: { permission } });
}

function setMode(mode) {
  return saveConfig({ ui: { mode: mode === 'work' ? 'work' : 'chat' } });
}

function setChatOptions(patch) {
  return saveConfig({ chat: patch });
}

function setWorkspace(dir) {
  const config = readConfig();
  const target = dir ? path.resolve(dir) : '';
  if (target) {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) throw new Error(`${target} is not a directory`);
  }
  const recents = (config.work?.recentWorkspaces || []).filter((item) => item !== target);
  if (target) recents.unshift(target);
  return saveConfig({
    work: {
      workspace: target,
      recentWorkspaces: recents.slice(0, 12)
    }
  });
}

/** 拉取模型列表（失败不阻断，允许手动填写） */
async function fetchModels({ providerRef, baseUrl, apiKey, protocol }) {
  const config = readConfig();
  const provider = providerRef ? findProvider(providerRef) : activeProvider(config);
  const targetBaseUrl = baseUrl || provider?.baseUrl;
  const targetProtocol = protocol || provider?.protocol || 'openai';
  if (!targetBaseUrl) throw new Error('Missing Base URL');
  let token = apiKey ?? provider?.apiKey ?? '';
  let authType = 'apiKey';
  if (provider && provider.authMode === 'oauth' && provider.oauthProvider && apiKey === undefined) {
    token = await oauth.getAccessToken(provider.oauthProvider);
    authType = 'oauth';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    return await listModels({ baseUrl: targetBaseUrl, apiKey: token, protocol: targetProtocol, authType, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function authOf(provider) {
  return resolveProviderAuth(provider);
}

function paths() {
  return {
    dataDir: cfg.DCB_DIR,
    config: cfg.CONFIG_PATH,
    chats: cfg.CHATS_PATH,
    mcp: cfg.MCP_PATH,
    skills: cfg.SKILLS_DIR,
    oauth: cfg.OAUTH_PATH
  };
}

function homeRelative(target) {
  const home = os.homedir();
  return target && String(target).startsWith(home) ? `~${String(target).slice(home.length)}` : target;
}

module.exports = {
  PERMISSIONS,
  PROTOCOL_META,
  readConfig,
  saveConfig,
  providers,
  findProvider,
  activeProvider,
  activeModel,
  availablePermissions,
  hasReviewModel,
  currentPermission,
  currentMode,
  upsertProvider,
  normalizeModels,
  removeProvider,
  moveProvider,
  setActiveModel,
  setPermission,
  setMode,
  setChatOptions,
  setWorkspace,
  fetchModels,
  authOf,
  paths,
  homeRelative,
  newId
};
