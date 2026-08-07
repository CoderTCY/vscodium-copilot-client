# 给 vscodium-copilot-fim 加 Copilot CLI MCP 集成（让终端里的 copilot CLI 连上 VSCodium 改代码）

## 目标

复刻官方 Copilot 扩展的 `~/.copilot/ide/` MCP 发现机制：本扩展启动一个进程内 MCP server，写 lock 文件，使得**已安装的官方 Copilot CLI（本机 1.0.78）在终端里运行时能自动发现 VSCodium 并连上来**，通过 `open_diff` 等工具在编辑器里展示并确认代码修改。

## 已用源码确认的官方机制（对接方是官方 CLI，必须完全对齐）

依据 `C:/Users/Administrator/Downloads/vscode-main/extensions/copilot/src/extension/chatSessions/copilotcli/` 与 CLI 包 `app.js`（1.0.70）：

1. **lock 文件**：`~/.copilot/ide/<uuid>.lock`，JSON 字段（zod schema，缺一不可）：
   `socketPath, scheme, headers, pid, timestamp, workspaceFolders[], ideName, isTrusted?`
2. **CLI 过滤条件**：schema 校验 → PID 存活（`kill(pid,0)`）→ socket 可达（`net.connect` 探测）→ **`workspaceFolders` 必须包含 CLI 的 cwd** → 无 ideName 白名单。→ 第三方合法 lock 会被接受。
3. **socket**：Windows 命名管道 `\\.\pipe\mcp-<uuid>.sock`（scheme `pipe`）；其他平台 tmpdir 下 unix socket（scheme `unix`）。
4. **认证**：`Authorization: Nonce <uuid>`，随机 nonce 写进 lock 的 headers；CLI 读 lock 后带上。
5. **MCP 端点**：`/mcp`（POST/GET/DELETE），用 `@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport` + express。会话标识 header：`x-copilot-session-id`（兼容 `mcp-session-id`）+ `x-copilot-pid` / `x-copilot-parent-pid`。
6. **工具 schema**（CLI 按此调用）：
   - `open_diff{original_file_path, new_file_contents, tab_name}` —— 打开只读双端 diff 视图，**阻塞直到用户接受/拒绝/关闭 tab**，返回 `{success, result:'SAVED'|'REJECTED', trigger, tab_name, message}`
   - `close_diff{tab_name}`、`get_diagnostics{uri?}`、`get_selection`、`get_vscode_info`、`update_session_name{name}`
7. **Accept/Reject 按钮**：`editor/title` 菜单 + `when <ctx>.hasActiveDiff` 上下文 + 两个注册命令 → `diff.resolve({status, trigger})`。
8. **只读虚拟文档**：`TextDocumentContentProvider`，自定义 scheme，双端内容由 `Map` 提供。
9. **push 通知**：`selection_changed` / `diagnostics_changed`（200ms 防抖，广播给所有连接的 transport）。
10. **文件写入不由服务端做**：官方 `open_diff` 只返回用户选择，文件落盘由 CLI 自己处理（我们的实现照做即可）。

## 新增运行时依赖（会被 bun build 打包进 out/extension.js）

- `@modelcontextprotocol/sdk`（MCP server 框架）
- `express`（HTTP 层） + `zod`（工具输入 schema）
- devDeps：`@types/express`、`@types/node`

> 风险/preflight：`bun build` 能否打包 SDK+express 是第一步要验证的。若失败 → 采用 Plan B（手写最小 JSON-RPC over HTTP 版 MCP server：只实现 `initialize` / `notifications/initialized` / `tools/list` / `tools/call`，工具 schema 与上面一致，用 `node:http` 监听命名管道）。

## 新增文件 `src/mcp/`

- `server.ts` —— 仿官方 `inProcHttpServer.ts`：express + 命名管道/unix socket 监听，`Nonce` 认证 middleware，`/mcp` 路由，`StreamableHTTPServerTransport` 会话管理（复用 `x-copilot-session-id`、`x-copilot-pid`），`sendNotification`/`broadcastNotification`，dispose 关闭。
- `lockFile.ts` —— `LockFileHandle`：创建/`update()`（工作区/信任变化时重写）/`remove()`，字段与官方一致；`getCopilotStateDir()` = `~/.copilot/ide`（`COPILOT_HOME` 环境变量已存在则优先）。
- `diffState.ts` —— `DiffStateManager`（`register/getByTabName/getByTab/getForCurrentTab/closeAllForSession` + 设置 ctx `copilotFim.cli.hasActiveDiff`）。
- `readonlyContentProvider.ts` —— scheme `vscodium-copilot-cli` 只读虚拟文档。
- `tools.ts` —— 6 个工具，schema 与参数和官方一致（open_diff 核心：读原文件→建双端只读 URIs→`vscode.commands.executeCommand('vscode.diff', …)->等待 resolve=`→返回 result）。
- `push.ts` —— selection/diagnostics 变更 → 防抖 → `broadcastNotification`。
- `contrib.ts` —— `CopilotCliMcpContrib`：构造 http server → 注册工具 + push → 写 lock → 注册命令（`copilotFim.cli.acceptDiff/rejectDiff`）→ dispose 时关 server/删 lock。

## `src/extension.ts` / `package.json` 变更

- `extension.ts`：`activate()` 里读取 `copilotFim.cliMcp.enabled`，为 true 时 `new CopilotCliMcpContrib()` 并 `subscriptions.push`（contrib 自带 dispose）；失败仅 `log` + 告警，不影响现有 FIM 补全。
- `package.json`：
  - `contributes.commands`：`copilotFim.cli.acceptDiff`、`copilotFim.cli.rejectDiff`（+ l10n 文案）
  - `contributes.menus.editor/title`：两个按钮，`when: copilotFim.cli.hasActiveDiff`
  - `contributes.configuration`：`copilotFim.cliMcp.enabled`（boolean，默认 true，附说明）
  - 版本 bump `0.1.10` → `0.2.0`

## 实施与验证步骤

1. **预检依赖打包**：装依赖，先 `bun run compile`（bun build --format cjs）跑通 SDK+express+ z.build 成功与否 → 决定走官方 SDK 路还是 Plan B。若刚启动的 SDK 全部 lazy (`import()`)，需确认 CJS 下可行。
2. 按上文件顺序实现。
3. `bun run typecheck`、`bun test`（现有 14 个测试不应受影响）。
4. `bun run compile` 通过后，`bunx @vscode/vsce package --allow-missing-repository --no-dependencies` 打 vsix（产物 `vscodium-copilot-fim-0.2.0.vsix`）。
5. **真机集成验证**（手动、写入 README）：安装 vsix → 重载 VSCodium → 打开某项目文件夹 → 终端（Git Bash/PowerShell）在该文件夹内运行 `copilot` → 期望扩展日志出现 `Client connected`；给 CLI 一条修改指令 → 编辑器出现 diff 视图 → 点 Accept → CLI 侧闭环。

## 风险与降级

- **SDK 无法 bundle**（ESM/顶层 await）→ Plan B 手写 JSON-RPC server（协议简单，工具 schema 不变）。
- **CLI 未装**：`~/.copilot/ide/` 有旧 0 字节 lock 残留，不影响；无法实测时提供日志诊断。
- 复杂度仅局限于新 `src/mcp/` 目录，不触碰现有 FIM 逻辑（补全、配额、token）。