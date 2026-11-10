#!/usr/bin/env node
'use strict';

/**
 * DgxayCode CLI 可执行入口。
 *
 * 全局安装后直接运行 `dgxay` 即可：
 *   npm install -g dgxay-code-cli
 *   dgxay
 *
 * 这里只做三件事：检查 Node 版本、屏蔽不兼容的交互环境、把控制权交给 src/cli/index.js。
 * 真正的参数解析与业务逻辑都在 cli 层，保证入口文件足够小、在任何平台都能被 npm 正常解析。
 */

const MIN_MAJOR = 18;

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(major) || major < MIN_MAJOR) {
  process.stderr.write(
    `DgxayCode CLI 需要 Node.js ${MIN_MAJOR} 或更高版本，当前为 ${process.versions.node}。\n` +
      '请升级 Node.js 后重试：https://nodejs.org/\n'
  );
  process.exit(1);
}

function run() {
  require('../src/cli/index.js')
    .main(process.argv.slice(2))
    .then((code) => {
      if (typeof code === 'number' && code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      const message = error && error.message ? error.message : String(error);
      process.stderr.write(`\n发生未处理的错误：${message}\n`);
      if (process.env.DGXAY_DEBUG === '1' && error && error.stack) {
        process.stderr.write(`${error.stack}\n`);
      }
      process.exitCode = 1;
    });
}

run();
