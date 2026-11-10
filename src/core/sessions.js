'use strict';

/**
 * 会话存储：~/.dcb/chats.json
 *
 * 存储结构兼容桌面版，便于两端共用同一个数据目录：
 * { id, title, mode, skill, createdAt, updatedAt, messages: [{role, content, ts, tools, files, ...}] }
 *
 * 最多保留 200 段对话（超出丢弃最旧的）；写入使用原子替换。
 */

const os = require('os');
const { loadChats, saveChats } = require('../services/config');

const MAX_CHATS = 200;

function newId(prefix = 'chat') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function titleFrom(text) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '新对话';
  return cleaned.length > 26 ? `${cleaned.slice(0, 26)}…` : cleaned;
}

function normalizeChat(chat) {
  if (!chat || typeof chat !== 'object') return null;
  return {
    id: String(chat.id || newId()),
    title: String(chat.title || '新对话'),
    mode: chat.mode === 'work' ? 'work' : 'chat',
    skill: typeof chat.skill === 'string' ? chat.skill : '',
    createdAt: Number(chat.createdAt) || Date.now(),
    updatedAt: Number(chat.updatedAt) || Date.now(),
    messages: Array.isArray(chat.messages) ? chat.messages.filter((m) => m && m.role) : []
  };
}

function sortChats(chats) {
  return chats.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 读取全部会话（按更新时间倒序） */
function listChats() {
  return sortChats(loadChats().map(normalizeChat).filter(Boolean));
}

function getChat(id) {
  if (!id) return null;
  return listChats().find((chat) => chat.id === id) || null;
}

/** 按序号（1 = 最新）或 id 前缀查找 */
function resolveChat(ref, chats = listChats()) {
  if (!ref) return null;
  const text = String(ref).trim();
  const exact = chats.find((chat) => chat.id === text);
  if (exact) return exact;
  const index = Number(text);
  if (Number.isInteger(index) && index >= 1 && index <= chats.length) return chats[index - 1];
  const prefixMatches = chats.filter((chat) => chat.id.startsWith(text));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    const error = new Error(`会话编号不唯一：「${text}」匹配到 ${prefixMatches.length} 个会话，请输入更长的 id`);
    error.code = 'AMBIGUOUS';
    throw error;
  }
  return null;
}

/** 保存单段会话（插入或更新），返回保存后的会话 */
function saveChat(chat) {
  const normalized = normalizeChat(chat);
  if (!normalized) throw new Error('无效的会话');
  if (!normalized.messages.length) return normalized;
  const chats = listChats();
  const index = chats.findIndex((item) => item.id === normalized.id);
  normalized.updatedAt = Date.now();
  if (index === -1) chats.unshift(normalized);
  else chats[index] = normalized;
  const trimmed = sortChats(chats).slice(0, MAX_CHATS);
  saveChats(trimmed);
  return normalized;
}

function deleteChat(id) {
  const chats = listChats();
  const next = chats.filter((chat) => chat.id !== id);
  if (next.length === chats.length) return false;
  saveChats(next.length ? next : []);
  return true;
}

function clearChats() {
  return saveChats([]);
}

function createChat(overrides = {}) {
  return {
    id: newId('chat'),
    title: '新对话',
    mode: overrides.mode === 'work' ? 'work' : 'chat',
    skill: typeof overrides.skill === 'string' ? overrides.skill : '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: []
  };
}

/* ------------------------------ 历史转换 ------------------------------ */

/** 发送给模型的消息：只保留 user / assistant 且有内容的部分（与桌面版 buildHistory 等价） */
function buildHistory(chat) {
  return (chat?.messages || [])
    .map((msg) => {
      if (!msg || !msg.role) return null;
      if (msg.compressed) return { role: 'user', content: `[上下文摘要]\n${String(msg.content || '').replace(/^> 上下文已压缩[^\n]*\n+/, '')}` };
      if (msg.role === 'terminal') {
        const output = `${msg.output || ''}${msg.stderr ? `\n${msg.stderr}` : ''}`.slice(0, 4000);
        return {
          role: 'user',
          content: `[终端命令] ${msg.command}\n[输出]\n${output}\n[退出码] ${
            msg.exitCode ?? (msg.status === 'running' ? '运行中' : '未知')
          }`
        };
      }
      if (msg.role !== 'user' && msg.role !== 'assistant') return null;
      if (!msg.content || msg.error) return null;
      return { role: msg.role, content: msg.content };
    })
    .filter(Boolean);
}

/** 每次请求只发送最近 N 条消息（与桌面版一致的 24 条） */
function trimHistory(history, limit = 24) {
  const list = Array.isArray(history) ? history : [];
  return limit > 0 ? list.slice(-limit) : list;
}

/* ------------------------------ token 估算 ------------------------------ */

function estimateTokens(text) {
  if (!text) return 0;
  let total = 0;
  for (const char of String(text)) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(char)) total += 1;
    else if (/\s/.test(char)) total += 0.25;
    else total += 0.28;
  }
  return Math.ceil(total);
}

function contextLimit(model) {
  const configured = Number(model?.contextWindow);
  if (configured > 0) return configured;
  if (model?.protocol === 'anthropic' || model?.protocol === 'responses') return 200000;
  return 128000;
}

function estimateChatTokens(chat) {
  let total = 700;
  if (!chat) return total;
  for (const msg of chat.messages || []) {
    if (msg.role === 'terminal') {
      total += estimateTokens(msg.command) + estimateTokens(msg.output) + estimateTokens(msg.stderr) + 12;
    } else {
      total += estimateTokens(msg.content) + 6;
    }
  }
  if (chat.skill) total += 1200;
  return Math.round(total);
}

function formatTokens(value) {
  const number = Math.max(0, Math.round(Number(value) || 0));
  if (number >= 10000) return `${Math.round(number / 1000)}k`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}k`;
  return String(number);
}

function homeShort(path) {
  const home = os.homedir();
  if (!path) return '';
  return String(path).startsWith(home) ? `~${String(path).slice(home.length)}` : String(path);
}

module.exports = {
  MAX_CHATS,
  newId,
  titleFrom,
  listChats,
  getChat,
  resolveChat,
  saveChat,
  deleteChat,
  clearChats,
  createChat,
  buildHistory,
  trimHistory,
  estimateTokens,
  estimateChatTokens,
  contextLimit,
  formatTokens,
  homeShort
};
