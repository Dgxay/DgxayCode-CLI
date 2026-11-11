'use strict';

/**
 * 测试运行器：内置最小断言框架，避免任何外部依赖。
 *
 *   node test/run.js            运行全部
 *   node test/run.js chat tools 只运行匹配的用例
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createMockServer } = require('./mock-server');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'dgxay.js');

const results = [];
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  process.stdout.write(`\n${name}\n`);
}

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ suite: currentSuite, name, ok: true, ms: Date.now() - started });
    process.stdout.write(`  ok   ${name} (${Date.now() - started}ms)\n`);
  } catch (err) {
    results.push({ suite: currentSuite, name, ok: false, error: err, ms: Date.now() - started });
    process.stdout.write(`  FAIL ${name}\n       ${err && err.message ? err.message.split('\n').join('\n       ') : err}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '值不相等'}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

function includes(text, needle, message) {
  if (!String(text).includes(needle)) {
    throw new Error(`${message || '未包含期望内容'}: ${needle}\n  实际输出前 800 字:\n${String(text).slice(0, 800)}`);
  }
}

/** 终端模拟：使用 test/term-emulator.js（按显示宽度维护网格） */
const { Term } = require('./term-emulator');

function makeFakeTerm(width = 80) {
  return new Term(width);
}

/* ------------------------------ 进程与配置辅助 ------------------------------ */

/** 建一个临时数据目录（清理由调用方负责） */
function makeHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dgxay-${name}-`));
}

/** 在指定数据目录下运行 CLI，返回 { code, stdout, stderr, output } */
function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DGXAY_HOME: options.home,
      NO_COLOR: '1',
      DGXAY_COLOR: 'never',
      ...(options.env || {})
    };
    if (options.unsetHome) delete env.DGXAY_HOME;
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd || ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    if (options.stdin !== undefined) child.stdin.end(String(options.stdin));
    else child.stdin.end();
    const timer = setTimeout(() => child.kill(), options.timeout || 60000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

function writeConfig(home, config) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function readJson(home, file) {
  return JSON.parse(fs.readFileSync(path.join(home, file), 'utf8'));
}

function baseConfig(baseUrl, protocol, extra = {}) {
  return {
    version: 1,
    onboarded: true,
    providers: [
      {
        id: 'prov_mock',
        name: 'Mock',
        protocol,
        baseUrl,
        apiKey: 'sk-test',
        authMode: 'apiKey',
        reviewModelId: 'mock-a',
        models: [{ id: 'mock-a', name: 'Mock A', contextWindow: 8000 }]
      }
    ],
    activeProviderId: 'prov_mock',
    activeModelId: 'mock-a',
    ui: { mode: 'chat', permission: 'normal' },
    work: { workspace: '', recentWorkspaces: [] },
    chat: { stream: true, temperature: 0.2, maxTokens: 1024, systemPrompt: '' },
    ...extra
  };
}

/* ------------------------------ 用例 ------------------------------ */

async function main() {
  const filter = process.argv.slice(2);
  const mock = createMockServer();
  const port = await mock.listen();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const homes = [];

  const homeOf = (name) => {
    const dir = makeHome(name);
    homes.push(dir);
    return dir;
  };

  const wanted = (suiteName) => !filter.length || filter.some((item) => suiteName.includes(item));

  try {
    /* ------------------------------ 基础 ------------------------------ */
    if (wanted('基础')) {
      suite('基础');
      await test('--version 输出 package.json 版本', async () => {
        const result = await runCli(['--version'], { home: homeOf('ver') });
        equal(result.code, 0);
        includes(result.stdout.trim(), require(path.join(ROOT, 'package.json')).version);
      });

      await test('--help 列出全部子命令', async () => {
        const result = await runCli(['--help'], { home: homeOf('help') });
        equal(result.code, 0);
        for (const name of ['run', 'chat', 'config', 'provider', 'model', 'oauth', 'mcp', 'skill', 'workspace', 'permission', 'doctor']) {
          includes(result.stdout, name);
        }
      });

      await test('未知子命令会当作提示词，缺配置时提示 init', async () => {
        const home = homeOf('noinit');
        const result = await runCli(['hello'], { home, stdin: '' });
        includes(result.output, 'config init');
      });

      await test('config path 显示数据目录', async () => {
        const home = homeOf('path');
        const result = await runCli(['config', 'path'], { home });
        equal(result.code, 0);
        includes(result.stdout, home);
      });
    }

    /* ------------------------------ 配置与供应商 ------------------------------ */
    if (wanted('配置')) {
      suite('配置与供应商');
      await test('config init 非交互写入供应商与模型', async () => {
        const home = homeOf('init');
        const result = await runCli(
          [
            'config',
            'init',
            '--protocol',
            'openai',
            '--name',
            'Mock',
            '--base-url',
            baseUrl,
            '--api-key',
            'sk-abc',
            '--model',
            'mock-a'
          ],
          { home }
        );
        equal(result.code, 0, result.output);
        const config = readJson(home, 'config.json');
        equal(config.providers.length, 1);
        equal(config.providers[0].protocol, 'openai');
        equal(config.providers[0].models[0].id, 'mock-a');
        equal(config.providers[0].apiKey, 'sk-abc');
        equal(config.onboarded, true);
        equal(config.activeModelId, 'mock-a');
      });

      await test('config show 打码 API Key', async () => {
        const home = homeOf('show');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        const result = await runCli(['config', 'show'], { home });
        equal(result.code, 0);
        includes(result.stdout, 'Mock');
        assert(!result.stdout.includes('sk-test'), 'API Key 不应明文出现');
      });

      await test('provider add / use / rm', async () => {
        const home = homeOf('provider');
        await runCli(['config', 'init', '--base-url', baseUrl, '--model', 'mock-a', '--name', 'A'], { home });
        let result = await runCli(
          ['provider', 'add', '--name', 'B', '--base-url', baseUrl, '--model', 'mock-b', '--protocol', 'anthropic'],
          { home }
        );
        equal(result.code, 0, result.output);
        let config = readJson(home, 'config.json');
        equal(config.providers.length, 2);
        equal(config.providers[1].name, 'B');

        result = await runCli(['provider', 'use', 'B'], { home });
        equal(result.code, 0, result.output);
        config = readJson(home, 'config.json');
        equal(config.activeProviderId, config.providers[1].id);

        result = await runCli(['provider', 'rm', 'B', '--yes'], { home });
        equal(result.code, 0, result.output);
        config = readJson(home, 'config.json');
        equal(config.providers.length, 1);
      });

      await test('model add / use / rm', async () => {
        const home = homeOf('model');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        let result = await runCli(['model', 'add', 'mock-b'], { home });
        equal(result.code, 0, result.output);
        result = await runCli(['model', 'use', 'mock-b'], { home });
        equal(result.code, 0, result.output);
        equal(readJson(home, 'config.json').activeModelId, 'mock-b');
        result = await runCli(['model', 'rm', 'mock-b'], { home });
        equal(result.code, 0, result.output);
        equal(readJson(home, 'config.json').providers[0].models.length, 1);
      });

      await test('model fetch 拉取模型列表', async () => {
        const home = homeOf('fetch');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        const result = await runCli(['model', 'fetch'], { home });
        equal(result.code, 0, result.output);
        includes(result.stdout, 'mock-a');
        includes(result.stdout, 'mock-b');
      });

      await test('permission set normal / full 写入配置', async () => {
        const home = homeOf('perm');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        let result = await runCli(['permission', 'set', 'full'], { home });
        equal(result.code, 0, result.output);
        equal(readJson(home, 'config.json').ui.permission, 'full');
        result = await runCli(['permission', 'set', 'normal'], { home });
        equal(result.code, 0, result.output);
      });
    }

    /* ------------------------------ 三种协议对话 ------------------------------ */
    if (wanted('协议')) {
      suite('三种协议单次对话');
      for (const protocol of ['openai', 'anthropic', 'responses']) {
        await test(`${protocol}：流式对话输出正文与用量`, async () => {
          const home = homeOf(`proto-${protocol}`);
          writeConfig(home, baseConfig(baseUrl, protocol));
          mock.reset();
          const result = await runCli(['run', '-p', '你好'], { home });
          equal(result.code, 0, result.output);
          includes(result.stdout, 'mock');
          includes(result.stdout, '你好');
          assert(mock.requests.length >= 1, '应当向 mock 发起请求');
          const pathOfRequest = mock.requests[mock.requests.length - 1].path;
          const expected =
            protocol === 'anthropic' ? '/messages' : protocol === 'responses' ? '/responses' : '/chat/completions';
          includes(pathOfRequest, expected);
        });
      }

      await test('anthropic 使用 x-api-key 与 anthropic-version', async () => {
        const home = homeOf('headers');
        writeConfig(home, baseConfig(baseUrl, 'anthropic'));
        mock.reset();
        await runCli(['run', '-p', '看看请求头'], { home });
        const headers = mock.requests[mock.requests.length - 1].headers;
        equal(headers['x-api-key'], 'sk-test');
        equal(headers['anthropic-version'], '2023-06-01');
        assert(!String(headers.authorization || '').includes('Bearer sk-test'), 'API Key 不应放在 Authorization');
      });

      await test('responses 不发送 temperature', async () => {
        const home = homeOf('resp-body');
        writeConfig(home, baseConfig(baseUrl, 'responses'));
        mock.reset();
        await runCli(['run', '-p', '检查请求体'], { home });
        const body = mock.requests[mock.requests.length - 1].body;
        assert(!('temperature' in body), 'Responses 不应发送 temperature');
        equal(body.max_output_tokens, 1024);
      });

      await test('思考内容折叠为一行摘要', async () => {
        const home = homeOf('think');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        const result = await runCli(['run', '-p', 'THINK 想想'], { home });
        includes(result.stdout, 'Thought for');
      });

      await test('--output json 输出结构化结果', async () => {
        const home = homeOf('json');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        const result = await runCli(['run', '-p', '你好', '-o', 'json'], { home });
        const data = JSON.parse(result.stdout.trim().split('\n\n').pop() || '{}');
        equal(data.ok, true);
        includes(data.text, 'mock');
      });

      await test('错误状态码给出可读信息', async () => {
        const home = homeOf('err');
        writeConfig(home, baseConfig('http://127.0.0.1:1/v1', 'openai'));
        const result = await runCli(['run', '-p', '你好'], { home, timeout: 30000 });
        assert(result.code !== 0, '错误时应返回非 0');
        includes(result.output, 'Error');
      });
    }

    /* ------------------------------ 工具与权限 ------------------------------ */
    if (wanted('工具')) {
      suite('工具循环与权限');
      await test('完全权限：read_file 工具被调用并回传结果', async () => {
        const home = homeOf('tool-read');
        const workspace = makeHome('ws-read');
        homes.push(workspace);
        fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello tool\n', 'utf8');
        writeConfig(home, baseConfig(baseUrl, 'openai', { ui: { mode: 'work', permission: 'full' } }));
        mock.reset();
        const result = await runCli(['run', '-p', 'TOOL_READ 读一下', '-C', workspace, '-m', 'work', '--permission', 'full'], {
          home
        });
        equal(result.code, 0, result.output);
        includes(result.stdout, 'Read note.txt');
        includes(result.stdout, 'mock');
        equal(mock.requests.length, 2, '应当发生两轮请求（工具调用 + 总结）');
        const second = JSON.stringify(mock.requests[1].body);
        includes(second, 'hello tool', '工具结果应回传给模型');
      });

      await test('无权限：read_file 仍可用，write_file 不在工具列表', async () => {
        const home = homeOf('tool-none');
        const workspace = makeHome('ws-none');
        homes.push(workspace);
        fs.writeFileSync(path.join(workspace, 'a.txt'), 'x', 'utf8');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        mock.reset();
        const result = await runCli(['run', '-p', '列个目录', '-C', workspace, '-m', 'work', '--permission', 'none'], {
          home
        });
        equal(result.code, 0, result.output);
        const tools = JSON.stringify(mock.requests[0].body.tools || []);
        includes(tools, 'read_file');
        assert(!tools.includes('write_file'), '无权限不应暴露 write_file');
        assert(!tools.includes('run_command'), '无权限不应暴露 run_command');
      });

      await test('普通权限 + 非交互：拒绝授权后工具不执行', async () => {
        const home = homeOf('tool-deny');
        const workspace = makeHome('ws-deny');
        homes.push(workspace);
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        mock.reset();
        const result = await runCli(
          ['run', '-p', 'TOOL_CMD 跑个命令', '-C', workspace, '-m', 'work', '--permission', 'normal'],
          { home }
        );
        includes(result.output, '[permission]');
        includes(result.output, 'Not an interactive terminal');
        equal(mock.requests.length, 2, '拒绝后仍应把错误回传给模型');
        const second = JSON.stringify(mock.requests[1].body);
        includes(second, 'declined');
      });

      await test('普通权限 + --yes：自动放行并执行工具', async () => {
        const home = homeOf('tool-yes');
        const workspace = makeHome('ws-yes');
        homes.push(workspace);
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        mock.reset();
        const result = await runCli(
          ['run', '-p', 'TOOL_CMD 跑个命令', '-C', workspace, '-m', 'work', '--permission', 'normal', '--yes'],
          { home }
        );
        equal(result.code, 0, result.output);
        includes(result.stdout, 'Run echo hello-from-mock');
        const second = JSON.stringify(mock.requests[1].body);
        includes(second, 'hello-from-mock');
      });

      await test('自动审查：审查模型放行后直接执行', async () => {
        const home = homeOf('tool-auto');
        const workspace = makeHome('ws-auto');
        homes.push(workspace);
        fs.writeFileSync(path.join(workspace, 'note.txt'), 'auto', 'utf8');
        writeConfig(home, baseConfig(baseUrl, 'openai', { ui: { mode: 'work', permission: 'auto' } }));
        mock.reset();
        const result = await runCli(['run', '-p', 'TOOL_READ 读一下', '-C', workspace, '-m', 'work'], { home });
        equal(result.code, 0, result.output);
        includes(result.stdout, 'Read note.txt');
      });

      await test('write_file 在工作空间内创建文件', async () => {
        const home = homeOf('tool-write');
        const workspace = makeHome('ws-write');
        homes.push(workspace);
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        const { execute } = require(path.join(ROOT, 'src', 'core', 'tools'));
        const ctx = { permission: 'full', workspace, requestApproval: async () => true };
        const out = await execute('write_file', { path: 'sub/new.txt', content: '内容' }, ctx);
        includes(out, 'Created');
        equal(fs.readFileSync(path.join(workspace, 'sub', 'new.txt'), 'utf8'), '内容');
        let denied = false;
        try {
          await execute('write_file', { path: 'x.txt', content: 'y' }, { permission: 'none', workspace });
        } catch (err) {
          denied = /does not allow|forbid/i.test(err.message);
        }
        assert(denied, '无权限写入必须被拒绝');
      });

      await test('普通权限缺少授权回调时拒绝执行', async () => {
        const { execute } = require(path.join(ROOT, 'src', 'core', 'tools'));
        let blocked = false;
        try {
          await execute('write_file', { path: 'x.txt', content: 'y' }, { permission: 'normal', workspace: process.cwd() });
        } catch (err) {
          blocked = /approval callback/i.test(err.message);
        }
        assert(blocked, '缺少授权回调必须被阻断');
      });
    }

    /* ------------------------------ 会话与压缩 ------------------------------ */
    if (wanted('会话')) {
      suite('会话与上下文');
      await test('单次对话保存到 chats.json 并可列出', async () => {
        const home = homeOf('session');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        await runCli(['run', '-p', '第一句话'], { home });
        const chats = readJson(home, 'chats.json');
        equal(chats.length, 1);
        equal(chats[0].messages[0].role, 'user');
        includes(chats[0].messages[0].content, '第一句话');
        const list = await runCli(['chat', 'list'], { home });
        includes(list.stdout, '第一句话');
      });

      await test('chat rm 删除会话', async () => {
        const home = homeOf('rm');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        await runCli(['run', '-p', '待删除'], { home });
        const result = await runCli(['chat', 'rm', '1'], { home });
        equal(result.code, 0, result.output);
        equal(readJson(home, 'chats.json').length, 0);
      });

      await test('chats.json 最多保留 200 段', async () => {
        const home = homeOf('cap');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        const many = Array.from({ length: 205 }, (_, i) => ({
          id: `chat_${i}`,
          title: `t${i}`,
          mode: 'chat',
          messages: [{ role: 'user', content: `m${i}` }],
          createdAt: Date.now(),
          updatedAt: Date.now() - i
        }));
        fs.writeFileSync(path.join(home, 'chats.json'), JSON.stringify(many), 'utf8');
        await runCli(['run', '-p', '再来一句'], { home });
        equal(readJson(home, 'chats.json').length, 200);
      });

      await test('/compress 用摘要替换历史', async () => {
        const home = homeOf('compress');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        await runCli(['run', '-p', '这是一段需要被压缩的对话'], { home });
        // 用 -c 恢复最近会话再压缩，模拟交互模式里的操作
        const result = await runCli(['-c'], { home, stdin: '/compress\n/exit\n' });
        includes(result.output, '压缩');
        const chats = readJson(home, 'chats.json');
        const messages = chats[0].messages.filter((m) => m.role !== 'terminal');
        assert(messages.length === 1 && messages[0].compressed, `压缩后应只剩一条摘要消息，实际 ${messages.length} 条`);
        includes(messages[0].content, '摘要');
      });

      await test('export 输出 Markdown', async () => {
        const home = homeOf('export');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        await runCli(['run', '-p', '导出我'], { home });
        const result = await runCli(['export'], { home });
        equal(result.code, 0, result.output);
        includes(result.stdout, '# 导出我');
        includes(result.stdout, '## DgxayCode');
      });
    }

    /* ------------------------------ 技能 / MCP / doctor ------------------------------ */
    if (wanted('扩展')) {
      suite('技能、MCP 与自检');
      await test('skill list 扫描 ~/.dcb/skills', async () => {
        const home = homeOf('skill');
        fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
        fs.writeFileSync(path.join(home, 'skills', 'review.md'), '---\nname: review\ndescription: 代码审查\n---\n\n审查步骤……', 'utf8');
        const result = await runCli(['skill', 'list'], { home });
        includes(result.stdout, 'review');
        includes(result.stdout, '代码审查');
      });

      await test('技能内容注入系统提示', async () => {
        const home = homeOf('skill-inject');
        fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
        fs.writeFileSync(path.join(home, 'skills', 'guide.md'), '---\nname: guide\n---\n\n这是一段独特的技能内容 ZZTOP。', 'utf8');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        mock.reset();
        await runCli(['run', '-p', '你好', '--skill', 'guide'], { home });
        const body = JSON.stringify(mock.requests[mock.requests.length - 1].body);
        includes(body, 'ZZTOP');
      });

      await test('mcp add / list 写入配置文件', async () => {
        const home = homeOf('mcp');
        let result = await runCli(['mcp', 'add', '--name', 'demo', '--command', 'node', '--args', '-e "console.log(1)"'], {
          home
        });
        equal(result.code, 0, result.output);
        const data = readJson(home, 'mcp.json');
        equal(data.servers.length, 1);
        equal(data.servers[0].name, 'demo');
        result = await runCli(['mcp', 'list'], { home });
        includes(result.stdout, 'demo');
      });

      await test('doctor --offline 输出自检项', async () => {
        const home = homeOf('doctor');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        const result = await runCli(['doctor', '--offline'], { home });
        equal(result.code, 0, result.output);
        includes(result.stdout, 'Data directory writable');
        includes(result.stdout, 'Mock');
      });

      await test('doctor 连通性测试成功', async () => {
        const home = homeOf('doctor-online');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        const result = await runCli(['doctor'], { home });
        equal(result.code, 0, result.output);
        includes(result.stdout, 'Connectivity');
        includes(result.stdout, 'ms');
      });
    }

    /* ------------------------------ 渲染与编辑器 ------------------------------ */
    if (wanted('单元')) {
      suite('单元：渲染与编辑');
      await test('Markdown 渲染标题/列表/代码/表格', async () => {
        const ansi = require(path.join(ROOT, 'src', 'cli', 'ansi'));
        const out = ansi.renderMarkdown(
          '# 标题\n\n- 项目一\n- 项目二\n\n```js\nconst a = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n',
          { width: 60 }
        );
        includes(out, '标题');
        includes(out, '项目一');
        includes(out, 'const a = 1;');
        includes(out, '┼');
      });

      await test('显示宽度：中文算 2，截断不破坏 ANSI', async () => {
        const ansi = require(path.join(ROOT, 'src', 'cli', 'ansi'));
        equal(ansi.displayWidth('中文ab'), 6);
        equal(ansi.displayWidth(ansi.stripAnsi('\x1b[31m红\x1b[0m')), 2);
        assert(ansi.truncate('中文中文中文', 7).length <= 4, '截断后长度应受控');
      });

      await test('参数解析：--key=value 与短选项', async () => {
        const { parseArgs } = require(path.join(ROOT, 'src', 'cli', 'args'));
        const spec = [
          { name: 'verbose', alias: 'v', type: 'boolean' },
          { name: 'name', alias: 'n', type: 'string' }
        ];
        const { options, positionals } = parseArgs(['-v', '--name=x', 'rest'], spec);
        equal(options.verbose, true);
        equal(options.name, 'x');
        equal(positionals[0], 'rest');

        const combined = parseArgs(['-vC', './proj'], [
          { name: 'verbose', alias: 'v', type: 'boolean' },
          { name: 'workspace', alias: 'C', type: 'string' }
        ]);
        equal(combined.options.verbose, true);
        equal(combined.options.workspace, './proj');
      });

      await test('参数解析：未知选项原样留给子命令', async () => {
        const { parseArgs } = require(path.join(ROOT, 'src', 'cli', 'args'));
        const global = [{ name: 'print', alias: 'p', type: 'boolean' }];
        const { positionals } = parseArgs(['mcp', '--name', 'demo'], global, { allowUnknown: true });
        equal(positionals[0], 'mcp');
        equal(positionals[1], '--name');
        equal(positionals[2], 'demo');
      });

      await test('actionFirst：动作名与选项分开解析', async () => {
        const { actionFirst } = require(path.join(ROOT, 'src', 'cli', 'args'));
        const parsed = actionFirst(['init', '--base-url', 'http://x/v1', '--model', 'a'], [
          { name: 'base-url', type: 'string' },
          { name: 'model', type: 'list' }
        ]);
        equal(parsed.action, 'init');
        equal(parsed.options.baseUrl, 'http://x/v1');
        equal(parsed.options.model[0], 'a');
      });

      await test('SSE 解析：\\n\\n 分隔与跨块 data 行', async () => {
        const { streamChat } = require(path.join(ROOT, 'src', 'core', 'llm'));
        const http = require('http');
        const server = http.createServer((req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          // 第一块只有一个字符，模拟 TCP 分片把 JSON 切开
          res.write('data: {"choi');
          res.write('ces":[{"index":0,"delta":{"content":"拼"}}]}\n\n');
          res.write('data: {"choices":[{"index":0,"delta":{"content":"接"}}]}\n\n');
          res.write('data: {"choices":[{"index":0,"delta":{"content":"成功"},"finish_reason":"stop"}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const deltas = [];
        const result = await streamChat({
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'k',
          protocol: 'openai',
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          onDelta: (text) => deltas.push(text)
        });
        server.close();
        equal(result.content, '拼接成功');
        equal(deltas.join(''), '拼接成功');
      });

      await test('系统提示包含权限与工作模式规则', async () => {
        const { systemPromptFor } = require(path.join(ROOT, 'src', 'core', 'prompt'));
        const prompt = systemPromptFor({ mode: 'work', permission: 'normal', workspace: '/tmp/ws' });
        includes(prompt, 'Execution discipline');
        includes(prompt, 'normal');
        includes(prompt, '/tmp/ws');
      });

      await test('未完成的收尾话术会被识别', async () => {
        const { looksUnfinishedWork } = require(path.join(ROOT, 'src', 'core', 'prompt'));
        assert(looksUnfinishedWork({ content: 'Next I will create the file.' }), 'should detect unfinished work');
        assert(!looksUnfinishedWork({ content: 'All changes are done and verified.' }), 'should not misfire');
      });
    }

    /* ------------------------------ 交互模式 ------------------------------ */
    if (wanted('交互')) {
      suite('交互模式（管道输入）');
      await test('发消息、/help、/exit 都能工作并正常退出', async () => {
        const home = homeOf('repl');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        mock.reset();
        const result = await runCli([], { home, stdin: '你好呀\n/help\n/exit\n' });
        equal(result.code, 0, result.output);
        includes(result.stdout, 'DgxayCode');
        includes(result.stdout, 'mock'); // 模型的回复
        includes(result.stdout, 'Commands'); // /help 的输出
        includes(result.stdout, 'Bye');
        assert(!/\x1b\[2K/.test(result.stdout), '管道输出不应包含清屏控制序列');
        const chats = readJson(home, 'chats.json');
        equal(chats[0].messages.filter((m) => m.role === 'user')[0].content, '你好呀');
      });

      await test('! 命令在终端执行并写入会话', async () => {
        const home = homeOf('repl-term');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        const result = await runCli(['--permission', 'full'], {
          home,
          stdin: `!${process.platform === 'win32' ? 'echo term-ok' : 'echo term-ok'}\n/exit\n`
        });
        includes(result.stdout, 'term-ok');
        const chats = readJson(home, 'chats.json');
        const terminalMessage = chats[0].messages.find((m) => m.role === 'terminal');
        assert(terminalMessage, '终端消息应写入会话');
        includes(terminalMessage.output, 'term-ok');
      });

      await test('/permission 与 /mode 切换写入配置', async () => {
        const home = homeOf('repl-perm');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        const result = await runCli([], { home, stdin: '/permission full\n/mode work\n/exit\n' });
        includes(result.stdout, 'Full access');
        const config = readJson(home, 'config.json');
        equal(config.ui.permission, 'full');
      });

      await test('/model 切换当前模型', async () => {
        const home = homeOf('repl-model');
        const config = baseConfig(baseUrl, 'openai');
        config.providers[0].models.push({ id: 'mock-b', name: 'Mock B', contextWindow: 0 });
        writeConfig(home, config);
        const result = await runCli([], { home, stdin: '/model mock-b\n/exit\n' });
        includes(result.stdout, 'Switched to');
        equal(readJson(home, 'config.json').activeModelId, 'mock-b');
      });

      await test('/skill 启用技能并注入提示', async () => {
        const home = homeOf('repl-skill');
        fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
        fs.writeFileSync(path.join(home, 'skills', 'qa.md'), '---\nname: qa\n---\n\nQA 技能内容 ZQX。', 'utf8');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        mock.reset();
        const result = await runCli([], { home, stdin: '/skill qa\n你好\n/exit\n' });
        includes(result.stdout, 'Skill enabled');
        const body = JSON.stringify(mock.requests[0].body);
        includes(body, 'ZQX');
      });
    }

    /* ------------------------------ 恢复 ------------------------------ */
    if (wanted('恢复')) {
      suite('会话恢复');
      await test('-c 继续最近会话时带上历史', async () => {
        const home = homeOf('resume');
        writeConfig(home, baseConfig(baseUrl, 'openai'));
        await runCli(['run', '-p', '第一轮问题'], { home });
        mock.reset();
        await runCli(['-c', '-p', '第二轮问题'], { home });
        const body = JSON.stringify(mock.requests[mock.requests.length - 1].body);
        includes(body, '第一轮问题');
        includes(body, '第二轮问题');
      });

      await test('流式渲染：TTY 下不出现「一段一行」堆积', async () => {
        const { StreamRenderer } = require(path.join(ROOT, 'src', 'cli', 'render'));
        // 极简终端模拟：支持 \r / \n / \b，不支持光标上移与清行
        const cells = [''];
        let column = 0;
        let raw = '';
        const out = {
          isTTY: true,
          columns: 80,
          write(chunk) {
            raw += chunk;
            for (const char of String(chunk)) {
              if (char === '\r') column = 0;
              else if (char === '\n') {
                cells.push('');
                column = 0;
              } else if (char === '\b') column = Math.max(0, column - 1);
              else {
                const arr = Array.from(cells[cells.length - 1] || '');
                while (arr.length < column) arr.push(' ');
                arr[column] = char;
                cells[cells.length - 1] = arr.join('');
                column += 1;
              }
            }
            return true;
          }
        };
        const renderer = new StreamRenderer({ output: out, redraw: true, width: 80 });
        const reply = '你好！我是 Agnes，由 Sapiens AI 开发的 AI 助手。请问有什么可以帮你的？';
        for (const piece of reply.match(/[\s\S]{1,3}/g)) renderer.handle({ type: 'delta', text: piece });
        renderer.handle({ type: 'done', usage: { prompt_tokens: 1, completion_tokens: 2 } });

        const lines = cells.map((line) => line.replace(/\s+$/, ''));
        const agnesLines = lines.filter((line) => line.includes('Agnes')).length;
        equal(agnesLines, 1, `正文只应出现一次，实际 ${agnesLines} 次`);
        assert(lines.some((line) => line.includes('你好！我是 Agnes')), '应包含完整正文');
        assert(!/\x1b\[\d*A/.test(raw), '不应使用光标上移序列');
        assert(!/\x1b\[2K/.test(raw), '不应使用清行序列');
      });

      await test('流式渲染：多段落 Markdown 各段落只出现一次', async () => {
        const { StreamRenderer } = require(path.join(ROOT, 'src', 'cli', 'render'));
        const cells = [''];
        let column = 0;
        const out = {
          isTTY: true,
          columns: 80,
          write(chunk) {
            for (const char of String(chunk)) {
              if (char === '\r') column = 0;
              else if (char === '\n') {
                cells.push('');
                column = 0;
              } else if (char === '\b') column = Math.max(0, column - 1);
              else {
                const arr = Array.from(cells[cells.length - 1] || '');
                while (arr.length < column) arr.push(' ');
                arr[column] = char;
                cells[cells.length - 1] = arr.join('');
                column += 1;
              }
            }
            return true;
          }
        };
        const renderer = new StreamRenderer({ output: out, redraw: true, width: 80 });
        const text = '第一段内容。\n\n- 列表项一\n- 列表项二\n\n```js\nconst a = 1;\n```';
        for (const piece of text.match(/[\s\S]{1,3}/g)) renderer.handle({ type: 'delta', text: piece });
        renderer.handle({ type: 'done' });
        const lines = cells.map((line) => line.replace(/\s+$/, ''));
        equal(lines.filter((line) => line.includes('第一段内容')).length, 1, '第一段只出现一次');
        equal(lines.filter((line) => line.includes('列表项一')).length, 1, '列表项一只出现一次');
        equal(lines.filter((line) => line.includes('const a = 1')).length, 1, '代码块只出现一次');
      });

      await test('流式渲染：管道模式不输出回车/退格控制符', async () => {
        const { StreamRenderer } = require(path.join(ROOT, 'src', 'cli', 'render'));
        const out = {
          isTTY: false,
          write(chunk) {
            this.buf = (this.buf || '') + chunk;
            return true;
          }
        };
        const renderer = new StreamRenderer({ output: out, redraw: false, width: 80 });
        const text = '你好！我是 Agnes。\n\n- 第一条\n- 第二条';
        for (const piece of text.match(/[\s\S]{1,3}/g)) renderer.handle({ type: 'delta', text: piece });
        renderer.handle({ type: 'done' });
        assert(!out.buf.includes('\r'), '管道输出不应包含回车符');
        assert(!out.buf.includes('\b'), '管道输出不应包含退格符');
        assert(!/\x1b\[\d*A/.test(out.buf), '管道输出不应包含光标上移');
        equal(out.buf.split('Agnes').length - 1, 1, '正文只出现一次');
        includes(out.buf, '第一条');
      });

      await test('行编辑器：逐字输入只重绘一组盒子', async () => {
        const { LineEditor } = require(path.join(ROOT, 'src', 'cli', 'editor'));
        const { EventEmitter } = require('events');
        const term = makeFakeTerm(72);
        const input = new EventEmitter();
        input.isTTY = true;
        input.setRawMode = () => {};
        input.resume = () => {};
        const editor = new LineEditor({
          input,
          output: term,
          placeholder: 'Ask',
          multiline: true,
          capabilities: { cursorUp: true, clearLine: true, interactive: true }
        });
        const done = editor.question();
        for (const char of '/permission full') input.emit('keypress', char, { name: char });
        // 按键处理是异步队列，等它跑完再断言
        await new Promise((resolve) => setTimeout(resolve, 30));
        const state = term.raw;
        input.emit('keypress', '\r', { name: 'return' });
        const result = await done;
        equal(result.value, '/permission full');
        // 每帧都要先擦除再重画：出现清行序列说明没有叠加
        assert(/\x1b\[2K/.test(state), '应逐行清空后再重绘');
        assert(/\x1b\[\d+A/.test(state), '应回到框架顶部');
        assert(state.includes('┐'), '应画出完整边框');
        equal(state.split('/permission full').length - 1, 1, '最后一次输入应只出现一次');
      });

      await test('行编辑器：降级终端仍能正常输入', async () => {
        const { LineEditor } = require(path.join(ROOT, 'src', 'cli', 'editor'));
        const { EventEmitter } = require('events');
        const term = makeFakeTerm(72);
        const input = new EventEmitter();
        input.isTTY = true;
        input.setRawMode = () => {};
        input.resume = () => {};
        const editor = new LineEditor({
          input,
          output: term,
          placeholder: 'Ask',
          multiline: true,
          capabilities: { cursorUp: false, clearLine: false, interactive: true }
        });
        const done = editor.question();
        for (const char of 'hi') input.emit('keypress', char, { name: char });
        await new Promise((resolve) => setTimeout(resolve, 30));
        input.emit('keypress', '\r', { name: 'return' });
        equal((await done).value, 'hi');
        assert(!/\x1b\[\d+A/.test(term.raw), '降级模式不应使用光标上移');
      });

      await test('行编辑器：Tab 补全走 item.apply 而不是 Function.prototype.apply', async () => {
        const { LineEditor } = require(path.join(ROOT, 'src', 'cli', 'editor'));
        const { EventEmitter } = require('events');
        const term = makeFakeTerm(80);
        const input = new EventEmitter();
        input.isTTY = true;
        input.setRawMode = () => {};
        input.resume = () => {};
        const completer = (value) =>
          value.startsWith('/')
            ? { items: [{ label: '/permission', apply: '/permission ' }], title: '斜杠命令' }
            : null;
        const editor = new LineEditor({ input, output: term, prompt: '› ', multiline: true, completer });
        const done = editor.question();
        for (const char of '/per') input.emit('keypress', char, { name: char });
        input.emit('keypress', '', { name: 'tab' });
        await new Promise((r) => setTimeout(r, 10));
        input.emit('keypress', '\r', { name: 'return' }); // 选中补全项
        await new Promise((r) => setTimeout(r, 10));
        input.emit('keypress', '\r', { name: 'return' }); // 提交
        const result = await done;
        equal(result.value, '/permission ');
      });

      await test('行编辑器：擦除框架后光标停在框架顶行，重绘不向下漂移', async () => {
        const { LineEditor } = require(path.join(ROOT, 'src', 'cli', 'editor'));
        const { EventEmitter } = require('events');
        const term = makeFakeTerm(72);
        const input = new EventEmitter();
        input.isTTY = true;
        input.setRawMode = () => {};
        input.resume = () => {};
        const editor = new LineEditor({
          input,
          output: term,
          placeholder: 'Ask',
          multiline: true,
          capabilities: { cursorUp: true, clearLine: true, interactive: true }
        });
        const done = editor.question();
        for (const char of 'hi') input.emit('keypress', char, { name: char });
        await new Promise((resolve) => setTimeout(resolve, 30));

        // 光标应停在盒子内容行；盒子固定在终端的当前行，不会额外往下跳
        const contentRow = term.row;
        includes(term.lines[contentRow], 'hi', '光标所在行应有输入内容');
        assert(
          term.lines.some((line) => line.startsWith('┌')),
          '应画出顶框'
        );
        assert(
          term.lines.some((line) => line.startsWith('└')),
          '应画出底框'
        );
        // 顶框与底框之间恰好隔一行内容
        const top = term.lines.findIndex((line) => line.startsWith('┌'));
        const bottom = term.lines.findIndex((line, i) => i > top && line.startsWith('└'));
        equal(bottom, top + 2, '盒子恰好三行');

        // 模拟多轮「收起 → 输出 → 重画」：每轮上方新增内容，盒子必须继续成为完整三行，
        // 不能出现两个顶框叠在上方这种残影。
        for (let round = 1; round <= 3; round += 1) {
          editor.suspend();
          term.write('answer line\n');
          term.write('usage line\n');
          editor.resume();
          const tops = term.lines.reduce((acc, line, i) => (line.startsWith('┌') ? [...acc, i] : acc), []);
          equal(tops.length, 1, `第 ${round} 轮应只有一个顶框（实际 ${tops.length} 个）`);
          const frame = term.lines.slice(tops[0], tops[0] + 3);
          includes(frame[1], 'hi', `第 ${round} 轮内容仍在框内`);
          assert(frame[2].startsWith('└'), `第 ${round} 轮底框位置正确`);
        }

        input.emit('keypress', '\r', { name: 'return' });
        equal((await done).value, 'hi');
      });

      await test('行编辑器：多行续写与超宽横向滚动', async () => {
        const { LineEditor } = require(path.join(ROOT, 'src', 'cli', 'editor'));
        const { EventEmitter } = require('events');
        const makeInput = () => {
          const input = new EventEmitter();
          input.isTTY = true;
          input.setRawMode = () => {};
          input.resume = () => {};
          return input;
        };

        const term1 = makeFakeTerm(80);
        const input1 = makeInput();
        const caps = { cursorUp: true, clearLine: true, interactive: true };
        const e1 = new LineEditor({ input: input1, output: term1, prompt: '› ', multiline: true, capabilities: caps });
        const d1 = e1.question();
        for (const char of '第一行\\') input1.emit('keypress', char, { name: char });
        await new Promise((r) => setTimeout(r, 20));
        input1.emit('keypress', '\r', { name: 'return' });
        for (const char of '第二行') input1.emit('keypress', char, { name: char });
        input1.emit('keypress', '\r', { name: 'return' });
        equal((await d1).value, '第一行\n第二行');

        const term2 = makeFakeTerm(40);
        const input2 = makeInput();
        const e2 = new LineEditor({ input: input2, output: term2, prompt: '› ', multiline: true, capabilities: caps });
        const d2 = e2.question();
        const long = '很长的输入内容'.repeat(10);
        for (const char of long) input2.emit('keypress', char, { name: char });
        await new Promise((r) => setTimeout(r, 40));
        input2.emit('keypress', '\r', { name: 'return' });
        equal((await d2).value, long);
        const widest = Math.max(...term2.lines.map((line) => line.length));
        assert(widest <= 40, `盒子不应超过终端宽度（实际 ${widest}）`);
        assert(term2.raw.includes('┐'), '应画出完整盒子');
      });

      await test('历史只发送最近 24 条', async () => {
        const { trimHistory } = require(path.join(ROOT, 'src', 'core', 'sessions'));
        const list = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `m${i}` }));
        const trimmed = trimHistory(list, 24);
        equal(trimmed.length, 24);
        equal(trimmed[0].content, 'm16');
      });
    }
  } finally {
    await mock.close();
    for (const dir of homes) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const failed = results.filter((item) => !item.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`);
  if (failed.length) {
    process.stdout.write('失败用例：\n');
    for (const item of failed) process.stdout.write(`  - [${item.suite}] ${item.name}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`测试运行器崩溃：${err?.stack || err}\n`);
  process.exitCode = 1;
});
