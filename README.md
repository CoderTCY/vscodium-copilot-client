# VSCodium Copilot Client

Fill-in-the-middle (FIM) inline completions ("ghost text") for VSCodium, talking to the
GitHub Copilot completion proxy directly — the same approach as copilot.vim / copilot.lua,
but as a native VS Code extension.

> ⚠️ **Disclaimer**: This project is independent and not affiliated with GitHub. It does not
> grant any rights to use GitHub, GitHub Copilot, their APIs, endpoints, trademarks, or
> services. Users are responsible for complying with applicable GitHub terms and maintaining
> any required Copilot subscription. The Copilot endpoints used here are **private /
> undocumented** and may change, be restricted, or stop working without notice.

## Features

- Ghost-text inline completions on every editor (prefix + suffix FIM)
- Automatic token refresh (`401`/`403` → re-authenticate)
- Model auto-detection from the CAPI `/models` endpoint, with `gpt-41-copilot` fallback
- Configurable token budgets

## Requirements

- [VSCodium](https://vscodium.com) (or any VS Code-family editor), v1.85+
- [bun](https://bun.sh) for building
- A GitHub account with a Copilot subscription

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

## Troubleshooting

- **401 / 403** — token invalid or expired: run *VSCodium Copilot Client: Refresh token*. If the GitHub
  session lacks the required scopes, sign out of GitHub in VSCodium and sign back in.
- **402** — free monthly quota exhausted.
- **429** — rate limited; wait a few seconds.
- **Basic errors, dialogs** — run *VSCodium Copilot Client: Check API status* to verify auth, proxy, and model
  list; watch the notification for the actual error.

## Project layout

```
src/
  extension.ts     entry point + inline completion provider
  token.ts         Copilot token exchange & caching
  models.ts        completion model list from CAPI /models
  completions.ts   SSE streaming against /v1/engines/{model}/completions
  truncate.ts      prefix/suffix token-budget truncation
  postprocess.ts   minimal completion cleaning
```