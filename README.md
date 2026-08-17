# VSCodium Copilot Client

Fill-in-the-middle (FIM) inline completions ("ghost text") for VSCodium, talking to the
GitHub Copilot completion proxy directly — the same approach as copilot.vim / copilot.lua,
but as a native VS Code extension. It also bridges the terminal **Copilot CLI** into
VSCodium through MCP, so `copilot` can open diff views here for you to review and approve.

> ⚠️ **Disclaimer**: This project is independent and not affiliated with GitHub. It does not
> grant any rights to use GitHub, GitHub Copilot, their APIs, endpoints, trademarks, or
> services. Users are responsible for complying with applicable GitHub terms and maintaining
> any required Copilot subscription. The Copilot endpoints used here are **private /
> undocumented** and may change, be restricted, or stop working without notice.

## Project status

This project is unmaintained. No support, compatibility updates, security fixes, or response
to issues and pull requests should be expected. Forks and independent maintenance are welcome.

## Features

- Ghost-text inline completions on every editor (prefix + suffix FIM)
- Automatic token refresh (`401`/`403` → re-authenticate)
- Model auto-detection from the CAPI `/models` endpoint, with `gpt-41-copilot` fallback
- Configurable token budgets
- **Copilot CLI MCP integration**: writing `copilot` inside a terminal auto-connects to
  VSCodium (via the official `~/.copilot/ide` lock-file discovery); file changes show up as
  read-only diff tabs with **Accept** / **Reject** buttons in the editor title bar

## Requirements

- [VSCodium](https://vscodium.com) (or any VS Code-family editor), v1.85+
- [bun](https://bun.sh) for building
- A GitHub account with a Copilot subscription
- For the CLI bridge: the official Copilot CLI / Codex CLI (`copilot`) installed

## Build & Install

```sh
bun install
bun run compile       # bundles to out/extension.js
bun run typecheck     # optional: TypeScript check
bun test              # optional: local smoke tests (SSE parsing etc.)
```

Two ways to load the extension:

1. **VSIX**: `bunx @vscode/vsce package`, then Extensions view → `...` → *Install from VSIX*.
2. **Extension Development Host**: open this folder in VSCodium and press `F5` (debug config
   is generated automatically by the built-in extension tooling).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `copilotClient.model` | `""` | Engine id. Empty = first completion model from the API. |
| `copilotClient.prefixTokens` | `1800` | Approx. token budget for the prefix (text before cursor). |
| `copilotClient.suffixTokens` | `500` | Approx. token budget for the suffix (text after cursor). |
| `copilotClient.maxTokens` | `2048` | Maximum tokens the model may generate. |
| `copilotClient.cliMcp.enabled` | `true` | Expose the Copilot CLI MCP server (`~/.copilot/ide` lockfile). |

## Using the Copilot CLI integration

1. Open a project folder in VSCodium.
2. In a terminal inside that folder, run `copilot` (the official Copilot CLI).
3. The extension logs `Client connected` (Output panel → `VSCodium Copilot Client`). Ask the CLI to make
   an edit; a read-only diff opens in the editor with **✓ Accept** / **✕ Reject** buttons.
4. The diff returns and the CLI continues — the file itself is written by the CLI.

You can turn the bridge off (e.g. to avoid connecting from a personal `copilot` session via
the same machine) by setting `copilotClient.cliMcp.enabled` to `false` and reloading.

## How it works

### FIM completions

1. `vscode.authentication` GitHub session → exchange the OAuth token for the Copilot API
   token at `https://api.github.com/copilot_internal/v2/token`
   (response also carries `endpoints.proxy`, the FIM base URL).
2. Prompt = text before the cursor (truncated), suffix = text after the cursor.
3. `POST {proxy}/v1/engines/{model}/completions` with SSE streaming
   (headers: `Authorization`, `OpenAI-Intent: copilot-ghost`, `X-GitHub-Api-Version`).
4. Post-process the stream, then return an `InlineCompletionItem` whose range covers the
   current line from its start to the cursor.

### Copilot CLI MCP bridge

1. On activation (if enabled) the extension starts an in-process MCP-over-HTTP server on a
   **named pipe** (`\\.\pipe\mcp-<uuid>.sock`, Windows) or a **unix socket**, and writes a
   `<uuid>.lock` file under `~/.copilot/ide` containing the socket path, PID, `Nonce` auth
   header, and the open workspace folders.
2. The Copilot CLI discovers it, validates the PID is alive and the socket answers, and
   connects with `Authorization: Nonce <the uuid>`.
3. Tools: `open_diff`, `close_diff`, `get_diagnostics`, `get_selection`, `get_vscode_info`,
   `update_session_name`. `open_diff` shows a read-only diff backed by
   `TextDocumentContentProvider` and blocks until you Accept / Reject / close — the file write
   is left to the CLI. Selection/diagnostics changes are pushed as notifications.
4. On disposal the server closes and the lock file is removed, so the CLI stops advertising
   VSCodium.

## Troubleshooting

- **401 / 403** — token invalid or expired: run *VSCodium Copilot Client: Refresh token*. If the GitHub
  session lacks the required scopes, sign out of GitHub in VSCodium and sign back in.
- **402** — free monthly quota exhausted.
- **429** — rate limited; wait a few seconds.
- **Basic errors, dialogs** — run *VSCodium Copilot Client: Check API status* to verify auth, proxy, and model
  list; watch the notification for the actual error.
- **CLI not connecting** — check the **Output panel → `VSCodium Copilot Client`** channel. You should see
  `MCP server listening on …` and `Client connected`. If the MCP server fails to start (for
  example the named pipe could not be created), the extension falls back to plain completions
  and logs `failed to start MCP server`.

## Project layout

```
src/
  extension.ts     entry point + inline completion provider
  token.ts         Copilot token exchange & caching
  models.ts        completion model list from CAPI /models
  completions.ts   SSE streaming against /v1/engines/{model}/completions
  truncate.ts      prefix/suffix token-budget truncation
  postprocess.ts   minimal completion cleaning
  mcp/
    server.ts      in-process MCP-over-HTTP server (pipe/unix socket, Nonce auth)
    lockFile.ts    ~/.copilot/ide lockfile (create/update/remove, stale cleanup)
    tools.ts       the six MCP tools (open_diff etc.)
    diffState.ts   active-diff tracking for Accept/Reject buttons
    readonly.ts    read-only virtual documents behind the diff
    push.ts        selection/diagnostics change notifications
    contrib.ts     wires server + tools + lockfile + commands together
```