# DgxayCode CLI

DgxayCode 的命令行版本：一个支持多协议、四档权限、自动审查、技能与 MCP 的 AI 编码助手。

桌面版（Electron）的全部能力都搬到了终端里，只去掉了界面：

- **三种接口协议**：OpenAI ChatCompletions、Anthropic Messages、OpenAI Responses，可自由切换供应商与模型
- **工作模式**：读写文件、执行命令、访问网络，先读后写、完成前不停止
- **四档权限**：无权限 / 普通权限 / 自动审查 / 完全权限，在进程内强制执行
- **自动审查**：由审查模型判断每次操作，可疑操作转交你确认
- **会话**：历史持久化、恢复、列表、重命名、删除、导出（最多保留 200 段）
- **上下文压缩**：`/compress` 用摘要替换历史
- **技能**：扫描 `~/.dcb/skills`，按会话启用
- **MCP**：配置、启停、日志
- **OAuth**：OpenAI / Anthropic / xAI / Google 账户连接（PKCE + 系统浏览器）
- **自检**：`dgxay doctor` 检查环境与模型连通性

## 安装

需要 **Node.js 18 或更高版本**。

```bash
npm install -g dgxay-code-cli
dgxay
```

也可以不安装直接用：

```bash
npx dgxay-code-cli --help
```

从源码安装：

```bash
git clone https://github.com/dgxay/DgxayCode.git
cd DgxayCode-cli
npm link          # 或 npm install -g .
dgxay --version
```

## 快速开始

```bash
# 1. 首次配置：选择协议、填写 Base URL / API Key / 模型
dgxay config init

# 2. 自检
dgxay doctor

# 3. 进入交互模式
dgxay
```

一条命令直接提问：

```bash
dgxay "把这个目录里的 JSON 合并成一个数组"

# 指定工作空间、工作模式、自动审查
dgxay run -p "给所有 Python 文件补上类型注解" -C ./project -m work --permission auto

# 结构化输出，方便接管道
dgxay run -p "总结这个仓库的架构" -o json | jq -r .text
```

## 交互模式

进��� `dgxay` 后：

| 输入 | 作用 |
| --- | --- |
| 直接输入文字 | 发送给模型 |
| `!命令` | 执行终端命令，输出进入对话上下文，例如 `!git status` |
| `/` | 打开斜杠命令补全 |
| 行尾 `\` | 续行，输入多行消息 |
| `Ctrl+C` | 生成中中断；空闲时退出；输入框有内容时清空 |
| `Ctrl+D` | 退出 |
| `↑` / `↓` | 浏览历史输入 |

### 斜杠命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 查看全部命令 |
| `/new` `/list` `/resume <序号>` `/delete <序号>` `/rename <标题>` | 会话管理 |
| `/compress`（`/压缩`） | 压缩上下文，有损且不可撤销 |
| `/skill [名称]`（`/技能`） | 列出 / 启用技能 |
| `/model` `/provider` | 查看或切换模型 / 供应商 |
| `/mode [chat\|work]` | 切换模式 |
| `/permission [档位]` | 切换权限 |
| `/cd <目录>` `/ls` `/pwd` | 工作空间 |
| `/term <命令>` | 执行终端命令 |
| `/context` | 上下文用量 |
| `/mcp [子命令]` | MCP 管理 |
| `/clear` `/exit` | 清屏 / 退出 |

## 子命令

```
dgxay                       进入交互模式
dgxay "问题"                 单次执行后退出
dgxay run                   单次执行（-p / -C / -m / --permission / -o json）
dgxay chat                  会话：list / show / resume / rm / rename / clear
dgxay config                init / show / get / set / path / reset
dgxay provider             list / add / edit / rm / use / mv / review
dgxay model                list / use / add / rm / fetch
dgxay oauth                list / connect / disconnect / client
dgxay mcp                  list / add / start / stop / logs / rm / env
dgxay skill                list / show / path
dgxay workspace            set / list / clear
dgxay permission           list / set
dgxay context              查看上下文估算
dgxay export               导出会话（Markdown / JSON）
dgxay doctor               自检
```

任何子命令都可以加 `--help` 查看详细用法。

## 权限

| 档位 | 能力 | 授权 |
| --- | --- | --- |
| `none` 无权限 | 只能以只读方式访问工作空间内的文件 | 无 |
| `normal` 普通权限 | 全部能力 | **每次**操作都要你确认 |
| `auto` 自动审查 | 全部能力 | 先由审查模型判断，可疑才询问 |
| `full` 完全权限 | 全部能力 | 不审查、不询问 |

- 权限在工具执行层强制校验，改前端（这里是交互层）绕不过去。
- 自动审查需要给供应商配置审查模型：`dgxay provider review <供应商> --model <模型ID>`；没配置时 `auto` 不可用，会自动回落到 `normal`。
- 非交互环境（管道输入）遇到需要确认的操作一律拒绝；确实要放行时加 `--yes`。
- 删除是**永久删除**，不进回收站；批量修改前请先提交 Git。

## 数据与配置

数据目录：`~/.dcb`（Windows 为 `%USERPROFILE%\.dcb`），与桌面版共用同一份配置与对话。

```
~/.dcb/
├── config.json     # 供应商、模型、审查模型、模式、权限
├── chats.json      # 对话历史（最多 200 段）
├── oauth.json      # OAuth 客户端与账户令牌（0600）
├── mcp.json        # MCP server 配置
└── skills/         # 技能（SKILL.md 或 name.md）
```

- API Key 在 `config.json` 中**是明文**；不要把该目录发到公开仓库。
- 用 `DGXAY_HOME=/tmp/test dgxay` 可以隔离数据目录（桌面版的 `DCB_HOME` 同样兼容）。
- 如果本机从桌面版迁移，OAuth 令牌由 Electron `safeStorage` 加密，CLI 无法解密，需要重新执行 `dgxay oauth connect <平台>`。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DGXAY_HOME` | 覆盖数据目录 |
| `DGXAY_API_KEY` | `config init` 时用作 API Key |
| `DGXAY_TOKEN_KEY` | 给 OAuth 令牌加解密口令（不设置则按明文 base64 保存） |
| `DGXAY_SHOW_REASONING=1` | 实时显示思考过程（默认折叠为一行摘要） |
| `DGXAY_COLOR=always\|never` | 强制开关颜色 |
| `NO_COLOR` | 关闭颜色 |
| `DGXAY_DEBUG=1` | 输出调试信息与堆栈 |
| `DGXAY_OAUTH_NO_BROWSER=1` | 授权时不自动打开浏览器（只打印链接） |

## 终端兼容性

流式输出只使用 `\r`（回到行首）和空格覆盖两种所有终端都支持的能力，**不依赖光标上移或清行序列**——
这两类序列在部分 Windows 控制台组合下会被忽略，导致每段增量都变成新的一行。

渲染分两步：生成过程中只在最后一行实时刷新预览；生成结束时一次性地按 Markdown 完整排版输出
（标题、列表、表格、代码块对齐）。所以在任何终端里每段正文都只会出现一次，不会堆积。

## 与桌面版的差异

- 没有窗口、没有快捷键，全部操作用命令或斜杠命令完成。
- 上下文圆环换成输入框上方的状态行和 `/context`。
- OAuth 令牌不再使用系统钥匙串加密；可用 `DGXAY_TOKEN_KEY` 开启加密。
- 补上了桌面版没有的能力：`dgxay run` 单次执行、`export` 导出、`doctor` 自检。

## 已知限制

- 每次请求只发送最近 **24 条**消息，更早的内容会被丢弃；长对话请先 `/compress` 或另起会话。
- `/compress` 有损且不可撤销。
- MCP 目前只管理进程，**尚未把 MCP 工具暴露给模型**（与桌面版一致）。
- 终端命令没有 PTY，不支持 `vim` / `top` / `ssh` 等交互式命令。
- 自动审查是 LLM，可能判断错误，不能代替人工审查。
- 上下文用量是字符启发式估算，实际 token 以模型返回的 `usage` 为准。

## 开发

```bash
npm test            # 运行全部测试（内置 mock 服务，不消耗真实额度）
npm run pack:check  # 检查 npm 发布内容
node bin/dgxay.js --help
```

测试覆盖：三种协议的流式与工具调用、权限矩阵（含拒绝路径）、会话持久化与压缩、SSE 分块解析、Markdown 渲染、参数解析。

## 许可证

GNU General Public License v3.0，见 [LICENSE](./LICENSE)。
