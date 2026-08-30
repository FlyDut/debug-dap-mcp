# debug-dap-mcp

DAP (Debug Adapter Protocol) **stdio MCP server**——通过一个 `debug` 工具把调试能力暴露给任意 MCP 客户端（Claude Code / OpenCode 等）。适配器进程由 server 派生，按内置/用户级/项目级三层配置解析。

- 单工具 `debug`，30 个 action（`launch`/`attach`/`continue`/`evaluate`/…），参数 camelCase
- 每次返回统一 JSON 载荷（`structuredContent` 与 `content[0].text` 同源）
- 自带 14 条内置适配器记录（gdb / lldb-dap / codelldb / debugpy / dlv / js-debug-adapter / netcoredbg / kotlin-debug-adapter / rdbg / php-debug-adapter / bash-debug-adapter / dart-debug-adapter / flutter-debug-adapter / elixir-ls-debugger）

## 安装

需要 Node.js ≥ 22。

```bash
npx -y git+https://github.com/FlyDut/debug-dap-mcp    # 直接运行 git 仓库（无需发布 npm，推荐）
npm i -g debug-dap-mcp        # 全局安装（发布到 npm 后）
npx debug-dap-mcp             # 或临时运行（发布到 npm 后）
```

启动后即一个 stdio MCP server；通常由 MCP 客户端作为子进程拉起，无需手动运行。

## MCP 客户端配置

### Claude Code（`.mcp.json` 或项目配置）

```json
{
  "mcpServers": {
    "debug-dap-mcp": {
      "command": "npx",
      "args": ["-y", "git+https://github.com/FlyDut/debug-dap-mcp"]
    }
  }
}
```

发布到 npm 后，`command` 可直接写 `debug-dap-mcp`（全局安装或 npx 解析）并清空 `args`。

### OpenCode（`opencode.json`）

```json
{
  "mcp": {
    "debug-dap-mcp": {
      "type": "local",
      "command": ["npx", "-y", "git+https://github.com/FlyDut/debug-dap-mcp"],
      "enabled": true
    }
  }
}
```

发布到 npm 后，`command` 可简写为 `["debug-dap-mcp"]`。

需要自定义 CLI 参数（如 `--no-project-config`）时并入 `args`/`command` 数组即可，见下文配置节。

## 31 action 速查表

一次 `callTool` 只执行一个 action（snake_case），参数 camelCase。公共参数：`sessionId`（缺省 = 焦点会话）、`timeout`（毫秒，clamp 到 `[5000, 300000]`，缺省 30000）。所有返回统一 JSON 载荷（`snapshot` 或查询族结构）。

| 分组 | action | 关键参数 |
|---|---|---|
| 会话 | `launch` | `program`, `adapter?`, `cwd?`, `args?`, `dapArguments?` |
| 会话 | `attach` | `pid`/`port` **二选一**（E-U3）, `host?`, `adapter?`, `dapArguments?` |
| 会话 | `terminate` | —（整树终止；无会话幂等 `snapshot:null`） |
| 会话 | `sessions` | —（整树快照 + `focusedSessionId`） |
| 断点 | `set_breakpoint` / `remove_breakpoint` | `file`, `line`, `condition?`, `hitCondition?` |
| 断点 | `set_function_breakpoint` / `remove_function_breakpoint` | `name`, `condition?`, `hitCondition?` |
| 断点 | `set_instruction_breakpoint` / `remove_instruction_breakpoint` | `instructionReference`, `offset?`, `condition?` |
| 断点 | `data_breakpoint_info` | `name`/`variablesReference` **至少给一**（E-U3） |
| 断点 | `set_data_breakpoint` / `remove_data_breakpoint` | `dataId`, `accessType?`(`read|write|readWrite`), `condition?` |
| 流控 | `continue` / `pause` / `step_over` / `step_in` / `step_out` | `threadId?` |
| 检查 | `stack_trace` | `threadId?`, `levels?` |
| 检查 | `threads` | —（整树聚合） |
| 检查 | `scopes` | `frameId?` |
| 检查 | `variables` | `variablesReference`, `start?`, `count?` |
| 检查 | `evaluate` | `expression`, `frameId?`, `context?` |
| 检查 | `exception_info` | `threadId?`（缺省回落当前 stop；无 stop 报 usage） |
| 检查 | `output` | `tail?`（字节，尾部截取） |
| 底层 | `disassemble` | `memoryReference`, `instructionCount?`, `instructionOffset?`, `offset?`, `resolveSymbols?` |
| 底层 | `read_memory` | `memoryReference`, `count?`, `offset?` |
| 底层 | `write_memory` | `memoryReference`, `data`（base64）, `offset?` |
| 底层 | `modules` | `startModule?`, `moduleCount?` |
| 底层 | `loaded_sources` | — |
| 底层 | `custom_request` | `command`, `arguments?`（逃生舱，透传任意 DAP 命令） |

错误统一 `isError:true` + JSON 错误体：`{ error:true, code, message, details? }`，`code ∈ { usage, capability, adapter, protocol }`。

## attach 指南

attach 请求体合成序（后者逐键覆盖）：适配器 `attachDefaults` ⊕ 结构化参数（`pid` 按记录 `pidArgument` 映射字段名；spawn 型的 `port`/`host`）⊕ `dapArguments`。各适配器对字段名的差异全部是配置数据，server 无特殊分支。

**pid 注入**（需要适配器声明相应能力；`dapArguments` 补齐适配器私有必填字段）：

```jsonc
// gdb（内置记录够用）
{"action":"attach","pid":12345}
// dlv（pidArgument: processId 已内置；显式写法等价）
{"action":"attach","pid":12345,"adapter":"dlv"}
// debugpy 1.8+（其请求体字段名为 processId、debugpyArgs 必填，均经 dapArguments 透传；
// 也可在用户级配置给 debugpy 记录加 "pidArgument": "processId" 省去前者）
{"action":"attach","pid":12345,"adapter":"debugpy",
 "dapArguments":{"processId":12345,"debugpyArgs":["--listen","127.0.0.1:0"]}}
```

**连接既有 DAP server**（用户级配置给适配器加 `"attachConnection": "connect"`，如 dlv 的 `dlv dap --listen=:5678` 或 js-debug 独立 `dapDebugServer`）：此时 `attach{port}` 的 `port` 即该 DAP 端点，MCP 不派生进程、直接连接后发 attach 请求体。

**debugpy 注意事项**：`python -m debugpy --listen 5678 app.py` 中的 5678 是 pydevd 引擎端口，**不是** DAP 端口——对它 `attach{port}` 不会工作（这是 debugpy 官方拓扑，非本 server 缺陷）。推荐路径是上方 pid 注入；`python -m debugpy.adapter --port N` 的独立 server 模式在 debugpy 1.8 存在 access-token 认证限制，第三方客户端不可直接复用。Linux 下 pid 注入还需目标进程可被 ptrace（`sysctl kernel.yama.ptrace_scope=0` 或同 uid 父子关系），Python 3.11+ 的 frozen modules 可能干扰注入（目标以 `-X frozen_modules=off` 启动更稳）。

**透传即语义**：断点 `verified` 标记、`variables` 的 `start/count` 分页效果均忠实透传各适配器行为（如 debugpy 对未解析位置的断点报 `verified:true`）；Windows 符号链接下 `source.path` 为适配器返回的真实路径。会话 terminated 后进入保留期（默认 5 min，`settings.terminatedRetentionMs` 可调），期间快照与 `output`/`exitCode` 仍可读且不阻塞新 `launch`。

## 配置三层

三层配置按 内置 < 用户级 < 项目级 合并；`settings` 与 `adapters` 深合并，**数组字段整体替换**（如 `args`、`fileTypes` 被上层完全替换而非拼接）：

| 层 | 位置 |
|---|---|
| 内置 | 随包分发 `adapters/defaults.json`（14 条记录） |
| 用户级 | `${XDG_CONFIG_HOME:-~/.config}/debug-dap-mcp/config.json`（`--config <path>` 可替换路径） |
| 项目级 | `<cwd>/.debug-dap-mcp.json` |

用户级示例（`~/.config/debug-dap-mcp/config.json`）：

```jsonc
{
  // 顶层 settings 覆盖
  "settings": { "binaryPreference": ["dlv"] },
  // 顶层 adapters 新增/覆盖记录（command/args/fileTypes/launchDefaults…）
  "adapters": {
    "my-gdb": {
      "command": "gdb",
      "args": ["-i", "dap"],
      "fileTypes": [".c", ".cpp"],
      "launchDefaults": { "request": "launch" }
    }
  }
}
```

配置文件用 JSON 或 JSONC（注释）皆可。

### 安全警示（`--no-project-config`）

项目级 `.debug-dap-mcp.json` 是「信任仓库即信任配置」：恶意仓库可把适配器 `command` 指向任意二进制，由 server 作为子进程执行。在不可信仓库中务必以 `--no-project-config` 启动（禁用项目级配置）。`--log-level debug` 会在 stderr 记录每次解析出的最终命令行，便于审计。

## 日志与排障

诊断全部写 **stderr**（stdout 只承载 MCP 帧）。级别解析：`--log-level <debug|info|warn|error>` 优先 → 否则 `DEBUG_DAP_MCP_LOG` → 否则 `info`。

```bash
debug-dap-mcp --log-level debug          # 帧收发摘要 + 适配器最终命令行
DEBUG_DAP_MCP_LOG=debug debug-dap-mcp    # 环境变量等价物
```

常见错误（`isError:true` 的 `code`）：

- `usage` — 参数校验失败 / 未知 action / 适配器选择失败（消息含候选与各自未中原因）/ `pid`-`port` 或 `name`-`variablesReference` 二选一违例 / 无活动会话
- `capability` — 适配器 capabilities 不支持该 action（如 `supportsModulesRequest` 缺席）
- `adapter` — 适配器启动失败（含 stderr 摘录与 `installHint`）或中途崩溃（含会话 id、退出码、stderr 摘录）
- `protocol` — DAP error response 或单请求超时

## 开发

```bash
npm run build       # tsc 编译到 dist/
npm run typecheck   # src + test 类型检查
npm test            # vitest 全套件（core + mcp + CLI + e2e）
```