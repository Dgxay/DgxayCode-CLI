# DgxayCode CLI

The command-line edition of DgxayCode: a multi-protocol AI coding agent with four permission levels, model-based safety review, skills and MCP support.

Everything the desktop (Electron) app can do is available here — only the UI is gone:

- **Three protocols** — OpenAI ChatCompletions, Anthropic Messages and OpenAI Responses; switch providers and models freely.
- **Work mode** — read/write files, run commands, fetch URLs; works through a task to completion instead of stopping at a plan.
- **Four permission levels** — none / normal / auto-review / full, enforced inside the tool layer.
- **Auto review** — a reviewer model judges each operation; suspicious ones are handed back to you.
- **Sessions** — persisted history, resume, list, rename, delete, export (200 sessions max).
- **Context compression** — `/compress` replaces history with a summary.
- **Skills** — scanned from `~/.dcb/skills`, enabled per conversation.
- **MCP** — configure, start, stop, inspect logs.
- **OAuth** — connect OpenAI / Anthropic / xAI / Google accounts (PKCE, system browser).
- **Self-check** — `dgxay doctor` verifies environment and model connectivity.

## Install

Requires **Node.js 18+**.

```bash
npm install -g dgxay-code-cli
dgxay
```

Or run without installing:

```bash
npx dgxay-code-cli --help
```

From source:

```bash
git clone https://github.com/dgxay/DgxayCode.git
cd DgxayCode-cli
npm link          # or: npm install -g .
dgxay --version
```

## Quick start

```bash
# 1. First-time setup: protocol, Base URL, API key, model
dgxay config init

# 2. Self-check
dgxay doctor

# 3. Interactive mode
dgxay
```

Ask once and exit:

```bash
dgxay "merge every JSON file in this folder into one array"

# work mode with auto review
dgxay run -p "add type hints to all Python files" -C ./project -m work --permission auto

# structured output
dgxay run -p "summarize this repo's architecture" -o json | jq -r .text
```

## Interactive mode

The interface has three parts:

- **Input box** — a bordered box that adapts to the terminal width and wraps long input
- **Command menu** — appears when you type `/`, navigable with the arrow keys
- **Thinking area** — shows a live timer and the model's reasoning while it works

| Input | Action |
| --- | --- |
| text | Send to the model |
| `/` | Open the command menu |
| `↑` / `↓` | Menu open: move the selection. Menu closed: `↑` recalls your previous prompt |
| `Tab` | Complete the selected command |
| `Enter` | Menu open: run the selected command. Otherwise: send the message |
| `Esc` | Close the menu |
| `!command` | Run a shell command; output joins the context, e.g. `!git status` |
| trailing `\` | Continue on the next line |
| `Ctrl+C` | Abort while generating; clear the input when non-empty; exit when idle |
| `Ctrl+D` | Exit |

### Language

The interface is English by default. Switch to Chinese with `DGXAY_LANG=zh dgxay`.
The AI replies in the language you write in.

### Thinking

While the model reasons, the terminal shows a live timer:

```
  ⠿ Thinking 2.4s latest reasoning fragment…
```

When it finishes, that folds into a one-line summary followed by the full reasoning in grey:

```
  ⌁ Thought for 12.8s · 1450 chars
  │ First I'll look at the directory layout…
  │ Then read the entry file…
```

Set `DGXAY_SHOW_REASONING=0` to keep only the summary.

### Slash commands

`/help` `/new` `/list` `/resume` `/delete` `/rename` `/compress` `/skill` `/model` `/provider` `/mode` `/permission` `/cd` `/ls` `/pwd` `/term` `/context` `/mcp` `/clear` `/exit`

## Subcommands

```
dgxay                       interactive mode
dgxay "question"            one-shot ask
dgxay run                   one-shot ask (-p / -C / -m / --permission / -o json)
dgxay chat                  list / show / resume / rm / rename / clear
dgxay config                init / show / get / set / path / reset
dgxay provider              list / add / edit / rm / use / mv / review
dgxay model                 list / use / add / rm / fetch
dgxay oauth                 list / connect / disconnect / client
dgxay mcp                   list / add / start / stop / logs / rm / env
dgxay skill                 list / show / path
dgxay workspace             set / list / clear
dgxay permission            list / set
dgxay context               context usage estimate
dgxay export                export a session (Markdown / JSON)
dgxay doctor                self-check
```

Every subcommand supports `--help`.

## Permissions

| Level | Capabilities | Approval |
| --- | --- | --- |
| `none` | read-only inside the workspace | none |
| `normal` | everything | **every** operation needs your confirmation |
| `auto` | everything | reviewer model decides; suspicious operations ask you |
| `full` | everything | no review, no prompts |

- Enforced in the tool layer — the UI (here, the REPL) cannot bypass it.
- Auto review requires a review model: `dgxay provider review <provider> --model <modelId>`; without it `auto` is unavailable and falls back to `normal`.
- In non-interactive pipelines, approval-requiring operations are denied unless you pass `--yes`.
- Deletions are **permanent** (no trash). Commit to Git before bulk edits.

## Data

`~/.dcb` (Windows: `%USERPROFILE%\.dcb`), shared with the desktop app:

```
~/.dcb/
├── config.json     # providers, models, review models, mode, permission
├── chats.json      # conversation history (200 sessions max)
├── oauth.json      # OAuth client + tokens (0600)
├── mcp.json        # MCP servers
└── skills/         # SKILL.md or name.md
```

API keys are stored **in plain text** in `config.json`. Use `DGXAY_HOME=/tmp/test dgxay` to isolate a data directory (desktop's `DCB_HOME` also works). OAuth tokens written by the desktop app are encrypted with Electron `safeStorage` and cannot be read by the CLI — reconnect with `dgxay oauth connect <platform>`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DGXAY_HOME` | Override the data directory |
| `DGXAY_API_KEY` | API key used by `config init` |
| `DGXAY_TOKEN_KEY` | Passphrase that encrypts OAuth tokens (plain base64 otherwise) |
| `DGXAY_LANG=zh` | Use the Chinese interface (English by default) |
| `DGXAY_SHOW_REASONING=0` | Show only the thinking summary, not the reasoning text |
| `DGXAY_REASONING_LINES=6` | How many reasoning lines to display |
| `DGXAY_NO_CURSOR_UP=1` | Force the single-line fallback input |
| `DGXAY_ASCII=1` | Force ASCII box drawing characters |
| `DGXAY_COLOR=always\|never` | Force colours on/off |
| `NO_COLOR` | Disable colours |
| `DGXAY_DEBUG=1` | Debug output and stack traces |
| `DGXAY_OAUTH_NO_BROWSER=1` | Don't open a browser during OAuth; print the URL only |

## Terminal compatibility

The terminal is probed at startup and the UI adapts:

**Cursor-up supported** (Windows Terminal, VSCode, iTerm, most Linux terminals)
The input is a real box and the command menu refreshes in place without leftovers.

**Cursor-up unsupported** (legacy conhost)
Falls back to a single-line `❯` prompt with in-place redraw, so nothing can stack up.

Streaming text always uses only `\r` and space padding; while generating, just the last line is refreshed, and
the whole reply is laid out once as Markdown at the end. Every paragraph appears exactly once.

Force the fallback with `DGXAY_NO_CURSOR_UP=1`, or ASCII borders with `DGXAY_ASCII=1`.

## Differences from the desktop app

- No window and no global shortcuts — everything is a subcommand or slash command.
- The context ring becomes a status line plus `/context`.
- OAuth tokens no longer use the OS keychain; set `DGXAY_TOKEN_KEY` to encrypt them.
- New in the CLI: `dgxay run`, `export`, `doctor`.

## Known limitations

- Only the most recent **24** messages are sent per request; compress or start a new session for long conversations.
- `/compress` is lossy and cannot be undone.
- MCP is process management only — MCP tools are **not** exposed to the model yet (same as desktop).
- Shell commands have no PTY: no `vim`, `top` or `ssh`.
- Auto review is an LLM and can be wrong; it is not a sandbox.
- Context usage is a character-based estimate; rely on the model's `usage` for real tokens.

## Development

```bash
npm test            # full suite against a built-in mock server (no real API usage)
npm run pack:check  # inspect the npm tarball
node bin/dgxay.js --help
```

## License

GNU General Public License v3.0 — see [LICENSE](./LICENSE). 中文说明见 [README-zh.md](./README-zh.md).
