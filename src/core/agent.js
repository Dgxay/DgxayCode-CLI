'use strict';

/**
 * Agent 循环：与桌面版 chat:send 的流程一致，把事件流交给上层（REPL / 单次运行）。
 *
 * 事件：
 *   status    { text }
 *   delta     { text }            正文增量
 *   reasoning { text }            思考增量
 *   tool      { id, name, status: 'running'|'ok'|'error', args, output, review }
 *   review    { toolId, name, kind, decision, reason, reviewer, modelId }
 *   review-start { toolId, name, kind }
 *   waiting   { toolId, name, kind, permission }
 *   file      { action, path, display, bytes }
 *   done      { text, usage }
 *   error     { message }
 *   aborted   {}
 *
 * 返回 { ok, aborted, text, reasoning, usage, toolLog, files, error }。
 */

const fs = require('fs');
const { streamChat } = require('./llm');
const tools = require('./tools');
const skills = require('../services/skills');
const {
  systemPromptFor,
  resolveProviderAuth,
  resolveReviewer,
  reviewOperation,
  looksUnfinishedWork,
  summarizeArgs
} = require('./prompt');
const { trimHistory } = require('./sessions');
const { t } = require('../cli/i18n');

const HISTORY_LIMIT = 24;
const MAX_STEPS_CHAT = 8;
const MAX_STEPS_WORK = 24;
const MAX_CONTINUATIONS = 2;

const VALID_PERMISSIONS = ['none', 'normal', 'auto', 'full'];

function describeOperation({ kind, name, args, command }) {
  const lines = [];
  if (kind === 'terminal') {
    lines.push(`Command: ${command || ''}`);
    return lines.join('\n');
  }
  lines.push(`Tool: ${name}`);
  if (args?.path) lines.push(`Path: ${args.path}`);
  if (args?.url) lines.push(`URL: ${args.url}`);
  if (args?.command) lines.push(`Command: ${args.command}`);
  if (args?.name) lines.push(`Name: ${args.name}`);
  const body = summarizeArgs(args);
  if (body && body !== '{}') lines.push(`Arguments: ${body}`);
  return lines.join('\n');
}

function normalizeHistory(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
}

function resolvePermissions(config) {
  const permission = VALID_PERMISSIONS.includes(config.ui?.permission) ? config.ui.permission : 'normal';
  if (permission === 'auto' && !resolveReviewer(config, config.activeProviderId)) {
    // 自动审查在未配置审查模型时不可用，与界面一致自动回落到普通权限
    return 'normal';
  }
  return permission;
}

/**
 * 请求一次操作的授权。
 * @param {object} options
 * @param {object} options.config
 * @param {string} options.permission
 * @param {(request)=>Promise<boolean>} options.askUser  用户确认回调
 * @param {(event)=>void} [options.emit]
 */
async function requestOperationApproval({ config, permission, kind, name, args, command, workspace, providerId, toolId, askUser, emit }) {
  if (permission === 'full') return { allow: true, source: 'full', review: null };
  if (permission !== 'normal' && permission !== 'auto') {
    return { allow: false, source: 'none', review: null, reason: 'Current permission level forbids this operation' };
  }

  if (permission === 'normal') {
    emit?.({ type: 'waiting', toolId, name, kind, permission });
    const allowed = await askUser({
      kind,
      permission,
      title: kind === 'terminal' ? t('approval_terminal') : t('approval_tool'),
      operation: name,
      detail: describeOperation({ kind, name, args, command }),
      command: command || '',
      workspace: workspace || '',
      review: '',
      reviewer: '',
      reviewModel: ''
    });
    return { allow: Boolean(allowed), source: 'user', review: null, reason: allowed ? '' : 'The user declined this operation' };
  }

  emit?.({ type: 'review-start', toolId, name, kind });
  const review = await reviewOperation({
    config,
    providerId: providerId || config.activeProviderId,
    kind,
    name,
    args,
    command,
    workspace
  });
  emit?.({
    type: 'review',
    toolId,
    name,
    kind,
    decision: review.decision,
    reason: review.reason,
    reviewer: review.reviewer,
    modelId: review.modelId
  });

  if (review.decision === 'allow') return { allow: true, source: 'auto', review };

  const allowed = await askUser({
    kind,
    permission,
    title: kind === 'terminal' ? t('approval_terminal') : t('approval_tool'),
    operation: name,
    detail: describeOperation({ kind, name, args, command }),
    command: command || '',
    workspace: workspace || '',
    review: review.reason,
    reviewer: review.reviewer,
    reviewModel: review.modelId
  });
  return { allow: Boolean(allowed), source: 'user', review, reason: allowed ? '' : 'The user declined this operation' };
}

function providerOf(config, providerId) {
  const providers = config.providers || [];
  return providers.find((p) => p.id === providerId) || providers.find((p) => p.id === config.activeProviderId) || providers[0] || null;
}

function modelOf(provider, modelId, config) {
  const models = provider?.models || [];
  return (
    models.find((m) => m.id === modelId)?.id ||
    models.find((m) => m.id === config.activeModelId)?.id ||
    models[0]?.id ||
    ''
  );
}

function normalizeWorkspace(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const stat = fs.statSync(raw);
    return stat.isDirectory() ? raw : '';
  } catch {
    return '';
  }
}

/**
 * 跑一轮完整对话（可能包含多次工具循环与自动续跑）。
 *
 * @param {object} options
 * @param {object} options.config        配置快照
 * @param {object[]} options.messages    历史消息 [{ role, content }]
 * @param {string} [options.providerId]
 * @param {string} [options.modelId]
 * @param {string} [options.mode]        'chat' | 'work'
 * @param {string} [options.permission]  none|normal|auto|full
 * @param {string} [options.workspace]
 * @param {string} [options.skill]       本次对话启用的技能名
 * @param {(request)=>Promise<boolean>} options.askUser
 * @param {(event)=>void} [options.onEvent]
 * @param {AbortSignal} [options.signal]
 */
async function runAgent({
  config,
  messages,
  providerId,
  modelId,
  mode = 'chat',
  permission,
  workspace,
  skill,
  askUser,
  onEvent,
  signal
}) {
  const resolvedMode = mode === 'work' ? 'work' : 'chat';
  if (!Array.isArray(messages) || !messages.length) {
    throw Object.assign(new Error('No messages: at least one user message is required'), { userError: true });
  }
  const provider = providerOf(config, providerId);
  if (!provider) throw new Error('Provider not found. Run dgxay provider add first');
  const targetModel = modelOf(provider, modelId, config);
  if (!targetModel) throw new Error('This provider has no models. Add one first');

  const effectivePermission = VALID_PERMISSIONS.includes(permission) ? permission : resolvePermissions(config);
  const activeWorkspace = normalizeWorkspace(workspace || config.work?.workspace || '');
  const useTools = resolvedMode === 'work' && Boolean(activeWorkspace);

  let toolDefs = [];
  if (useTools) toolDefs = tools.toolsFor(effectivePermission);
  else if (effectivePermission !== 'none') toolDefs = [tools.DEFINITIONS.install_mcp_server];

  const activeSkill = skill ? skills.readSkill(skill) : null;

  const apiMessages = [
    {
      role: 'system',
      content: systemPromptFor({
        mode: resolvedMode,
        permission: effectivePermission,
        workspace: activeWorkspace,
        customPrompt: config.chat?.systemPrompt,
        skill: activeSkill
      })
    },
    ...trimHistory(normalizeHistory(messages), HISTORY_LIMIT)
  ];

  const settings = config.chat || {};
  const providerAuth = await resolveProviderAuth(provider);

  let finalText = '';
  let reasoningText = '';
  let totalUsage = null;
  const toolLog = [];
  const files = [];
  let aborted = false;

  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {
      /* 渲染层异常不应打断对话 */
    }
  };

  try {
    const maxSteps = useTools ? MAX_STEPS_WORK : MAX_STEPS_CHAT;
    let continuationCount = 0;

    for (let step = 0; step < maxSteps; step += 1) {
      emit({ type: 'status', text: step === 0 ? 'Working' : 'Continuing' });
      const result = await streamChat({
        protocol: provider.protocol || 'openai',
        baseUrl: provider.baseUrl,
        apiKey: providerAuth.apiKey,
        authType: providerAuth.authType,
        model: targetModel,
        messages: apiMessages,
        tools: toolDefs,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        stream: settings.stream !== false,
        signal,
        onDelta: (text) => {
          finalText += text;
          emit({ type: 'delta', text });
        },
        onReasoning: (text) => {
          reasoningText += text;
          emit({ type: 'reasoning', text });
        }
      });

      if (result.usage) totalUsage = result.usage;

      if (Array.isArray(result.toolCalls) && result.toolCalls.length) {
        const calls = result.toolCalls
          .filter((call) => call?.function?.name)
          .map((call, index) => ({
            id: call.id || `call_${step}_${index}`,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments || '{}' }
          }));
        if (!calls.length) break;

        apiMessages.push({ role: 'assistant', content: result.content || null, tool_calls: calls });

        for (const call of calls) {
          const toolId = `t_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
          const name = call.function.name;
          emit({ type: 'tool', id: toolId, name, status: 'running', args: call.function.arguments });
          let output = '';
          let ok = true;
          let lastReview = null;
          try {
            const args = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {};
            const requestApproval = async (operation) => {
              const decision = await requestOperationApproval({
                config,
                permission: effectivePermission,
                kind: 'tool',
                name: operation.name,
                args: operation.args,
                workspace: activeWorkspace,
                providerId: provider.id,
                toolId,
                askUser,
                emit
              });
              lastReview = decision;
              return decision.allow;
            };
            output = await tools.execute(name, args, {
              permission: effectivePermission,
              workspace: activeWorkspace,
              requestApproval,
              onFile: (file) => {
                files.push(file);
                emit({ type: 'file', ...file });
              }
            });
          } catch (err) {
            ok = false;
            output = `Error: ${err.message}`;
          }
          const logItem = {
            id: toolId,
            name,
            args: call.function.arguments,
            ok,
            output,
            review: lastReview
              ? {
                  source: lastReview.allow ? lastReview.source : 'denied',
                  decision: lastReview.review?.decision || (lastReview.allow ? 'allow' : 'review'),
                  reason: lastReview.review?.reason || lastReview.reason || ''
                }
              : undefined,
            at: Date.now()
          };
          toolLog.push(logItem);
          emit({
            type: 'tool',
            id: toolId,
            name,
            status: ok ? 'ok' : 'error',
            output: output.slice(0, 4000),
            review: logItem.review
          });
          apiMessages.push({ role: 'tool', tool_call_id: call.id, content: output });
        }
        if (finalText) {
          finalText += '\n\n';
          emit({ type: 'delta', text: '\n\n' });
        }
        continue;
      }

      // 工作模式：模型提前收尾时自动推进一步，避免任务只做了一半
      if (
        resolvedMode === 'work' &&
        useTools &&
        continuationCount < MAX_CONTINUATIONS &&
        step < maxSteps - 1 &&
        looksUnfinishedWork(result)
      ) {
        continuationCount += 1;
        if (result.content) apiMessages.push({ role: 'assistant', content: result.content });
        apiMessages.push({
          role: 'user',
          content:
            'Continue until the task is fully done. Do not describe a plan or promise a next step — call the tools to finish the remaining work, verify the result, then give a short summary.'
        });
        if (finalText) {
          finalText += '\n\n';
          emit({ type: 'delta', text: '\n\n' });
        }
        emit({ type: 'status', text: 'Continuing the task' });
        continue;
      }

      break;
    }

    emit({ type: 'done', text: finalText, usage: totalUsage });
    return { ok: true, text: finalText, reasoning: reasoningText, usage: totalUsage, toolLog, files };
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      aborted = true;
      emit({ type: 'aborted' });
      return { ok: false, aborted: true, text: finalText, reasoning: reasoningText, usage: totalUsage, toolLog, files };
    }
    emit({ type: 'error', message: err.message });
    return {
      ok: false,
      error: err.message,
      text: finalText,
      reasoning: reasoningText,
      usage: totalUsage,
      toolLog,
      files
    };
  }
}

module.exports = {
  HISTORY_LIMIT,
  MAX_STEPS_CHAT,
  MAX_STEPS_WORK,
  requestOperationApproval,
  describeOperation,
  providerOf,
  modelOf,
  resolvePermissions,
  runAgent
};
