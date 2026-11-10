'use strict';

/**
 * 测试用 mock 模型服务：同时实现三种协议，按「用户消息里的关键词」决定行为。
 *
 * 关键词：
 *   TOOL_READ  → 第一轮返回 read_file 工具调用，第二轮返回文本总结
 *   TOOL_CMD   → 返回 run_command 工具调用
 *   THINK      → 正文前先返回一段 reasoning
 *   SLOW       → 每 200ms 输出一小段，共 250 段（用于测试中断）
 *   COMPRESS   → 原文中带「压缩」，返回摘要（供 /compress 使用）
 * 其余 → 固定文本流
 *
 * 只绑定 127.0.0.1，避免暴露到局域网。
 */

const http = require('http');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
}

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user') return String(message.content || '');
  }
  return '';
}

function hasToolResult(messages) {
  return messages.some((m) => m.role === 'tool' || m.type === 'function_call_output');
}

function plan(body) {
  const messages = body.messages || body.input || [];
  const text = lastUser(messages);
  const used = hasToolResult(messages);
  const wantTool = /TOOL_READ|TOOL_CMD/.test(text) && !used;
  const toolResultText = JSON.stringify(messages);
  return {
    tool: wantTool ? (/TOOL_CMD/.test(text) ? 'run_command' : 'read_file') : null,
    think: /THINK/.test(text),
    slow: /SLOW/.test(text),
    compress: /压缩/.test(text),
    sawToolResult: toolResultText.includes('hello tool') || toolResultText.includes('hello-from-mock'),
    echo: text.replace(/\s+/g, ' ').trim().slice(0, 60)
  };
}

function toolArgs(name) {
  return name === 'run_command'
    ? { command: 'echo hello-from-mock' }
    : { path: 'note.txt' };
}

/* ------------------------------ OpenAI ChatCompletions ------------------------------ */

async function handleOpenAI(req, res, body) {
  const p = plan(body);
  if (body.stream === false) {
    const content = p.compress
      ? '【压缩摘要】用户希望验证 CLI；已完成配置与工具调用。'
      : p.tool
        ? 'mock: 即将调用工具'
        : 'mock 回复：收到消息 ' + p.echo;
    const payload = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: p.tool
            ? {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_mock_1',
                    type: 'function',
                    function: { name: p.tool, arguments: JSON.stringify(toolArgs(p.tool)) }
                  }
                ]
              }
            : { role: 'assistant', content },
          finish_reason: p.tool ? 'tool_calls' : 'stop'
        }
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  sse(res);
  if (p.think) {
    for (const piece of ['先理解', '用户意图。', '准备回答。']) {
      send(res, { choices: [{ index: 0, delta: { reasoning_content: piece } }] });
    }
  }
  if (p.tool) {
    const args = JSON.stringify(toolArgs(p.tool));
    send(res, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_mock_1', type: 'function', function: { name: p.tool, arguments: '' } }
            ]
          }
        }
      ]
    });
    for (let i = 0; i < args.length; i += 8) {
      send(res, {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 8) } }] } }]
      });
    }
    send(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const fence = '`'.repeat(3);
  const text = p.compress
    ? '【压缩摘要】用户希望验证 **CLI**，已完成配置与工具调用，待办：检查打包。'
    : p.slow
      ? Array.from({ length: 250 }, (_, i) => `段${i} `).join('')
      : `mock 回复：收到消息 ${p.echo}${p.sawToolResult ? '（工具结果已回传）' : ''}\n\n- 第一项\n- 第二项\n\n${fence}js\nconsole.log("hi");\n${fence}`;
  const pieces = text.match(/[\s\S]{1,3}/g) || [];
  for (const piece of pieces) {
    send(res, { choices: [{ index: 0, delta: { content: piece } }] });
    if (p.slow) await new Promise((r) => setTimeout(r, 40));
  }
  send(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

/* ------------------------------ Anthropic Messages ------------------------------ */

async function handleAnthropic(req, res, body) {
  const p = plan(body);
  if (body.stream === false) {
    const payload = p.compress
      ? { content: [{ type: 'text', text: '【压缩摘要】anthropic 摘要结果。' }], stop_reason: 'end_turn' }
      : p.tool
        ? {
            content: [{ type: 'tool_use', id: 'toolu_mock_1', name: p.tool, input: toolArgs(p.tool) }],
            stop_reason: 'tool_use'
          }
        : {
            content: [{ type: 'text', text: `mock anthropic 回复：${p.echo}` }],
            usage: { input_tokens: 9, output_tokens: 5 }
          };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  sse(res);
  const write = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  write('message_start', { message: { usage: { input_tokens: 9 } } });
  if (p.think) {
    write('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
    for (const piece of ['思考中', '…']) {
      write('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: piece } });
    }
    write('content_block_stop', { index: 0 });
  }
  if (p.tool) {
    write('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_mock_1', name: p.tool, input: {} } });
    const args = JSON.stringify(toolArgs(p.tool));
    for (let i = 0; i < args.length; i += 6) {
      write('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(i, i + 6) } });
    }
    write('content_block_stop', { index: 1 });
    write('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } });
    res.end();
    return;
  }
  write('content_block_start', { index: 2, content_block: { type: 'text', text: '' } });
  const text = p.compress
    ? '【压缩摘要】anthropic 压缩结果：用户验证 CLI，待办：发布。'
    : `mock anthropic 回复：${p.echo}`;
  for (const piece of text.match(/[\s\S]{1,5}/g) || []) {
    write('content_block_delta', { index: 2, delta: { type: 'text_delta', text: piece } });
  }
  write('content_block_stop', { index: 2 });
  write('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } });
  write('message_stop', {});
  res.end();
}

/* ------------------------------ OpenAI Responses ------------------------------ */

async function handleResponses(req, res, body) {
  const p = plan(body);
  if (body.stream === false) {
    const payload = p.compress
      ? {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '【压缩摘要】responses 摘要结果。' }] }],
          usage: { input_tokens: 8, output_tokens: 4 }
        }
      : p.tool
        ? {
            status: 'completed',
            output: [
              {
                type: 'function_call',
                id: 'fc_mock',
                call_id: 'call_mock_r1',
                name: p.tool,
                arguments: JSON.stringify(toolArgs(p.tool))
              }
            ]
          }
        : {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: `mock responses 回复：${p.echo}` }] }],
            usage: { input_tokens: 8, output_tokens: 4 }
          };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  sse(res);
  const write = (type, data) => send(res, { type, ...data });
  if (p.think) {
    for (const piece of ['responses 思考', '片段']) {
      write('response.reasoning_summary_text.delta', { delta: piece });
    }
  }
  if (p.tool) {
    write('response.output_item.added', {
      item: { id: 'fc_mock', type: 'function_call', call_id: 'call_mock_r1', name: p.tool, arguments: '' }
    });
    const args = JSON.stringify(toolArgs(p.tool));
    for (let i = 0; i < args.length; i += 7) {
      write('response.function_call_arguments.delta', { item_id: 'fc_mock', delta: args.slice(i, i + 7) });
    }
    write('response.output_item.done', {
      item: { id: 'fc_mock', type: 'function_call', call_id: 'call_mock_r1', name: p.tool, arguments: args }
    });
    write('response.completed', { response: { status: 'completed', usage: { input_tokens: 8, output_tokens: 9 } } });
    res.end();
    return;
  }
  const text = p.compress ? '【压缩摘要】responses 压缩结果：验证完成。' : `mock responses 回复：${p.echo}`;
  write('response.output_item.added', { item: { id: 'msg_1', type: 'message', content: [] } });
  for (const piece of text.match(/[\s\S]{1,5}/g) || []) {
    write('response.output_text.delta', { delta: piece });
  }
  write('response.output_item.done', { item: { id: 'msg_1', type: 'message', content: [] } });
  write('response.completed', { response: { status: 'completed', usage: { input_tokens: 8, output_tokens: 10 } } });
  res.end();
}

/* ------------------------------ 服务器 ------------------------------ */

function createMockServer(options = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      const auth = req.headers.authorization || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-b' }], auth }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      body = {};
    }
    requests.push({ path: url.pathname, headers: req.headers, body });

    try {
      if (url.pathname.endsWith('/chat/completions')) await handleOpenAI(req, res, body);
      else if (url.pathname.endsWith('/messages')) await handleAnthropic(req, res, body);
      else if (url.pathname.endsWith('/responses')) await handleResponses(req, res, body);
      else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `unknown path ${url.pathname}` } }));
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    }
  });

  return {
    server,
    requests,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    get baseUrl() {
      const address = server.address();
      return `http://127.0.0.1:${address.port}/v1`;
    },
    reset() {
      requests.length = 0;
    }
  };
}

module.exports = { createMockServer };

if (require.main === module) {
  const mocks = createMockServer();
  mocks.listen(Number(process.env.PORT) || 0).then((port) => {
    process.stdout.write(`mock server on http://127.0.0.1:${port}/v1\n`);
  });
}
