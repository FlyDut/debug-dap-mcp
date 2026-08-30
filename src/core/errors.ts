/**
 * 错误模型（DESIGN.md §7.1 固化，api-contract §3.7）。
 *
 * 四类 code：usage / capability / adapter / protocol。`DebugToolError` 是内部抛出形态；
 * MCP 层捕获后经 `toToolErrorBody()` 渲染为 `ToolErrorBody`（`isError: true` + JSON 错误体）。
 * 本文件固化 E-U1..E-U7、E-C1、E-A1、E-A2、E-A3、E-P1、E-P2 编号的消息模板
 * （api-contract §3.7 表），供后续层直接构造，避免各处手工拼装消息字符串。
 * E-U3（适配器选择/模板展开失败）由 adapter-registry 消费：本文件提供
 * `adapterSelectionError`/`unknownAdapterError`/`attachTargetError` 三工厂（候选与未中原因逐条列出、
 * 显式 adapter 未注册、attach 二选一）；模板变量违例的 usage 由 template.ts 抛出。
 */

export type ErrorCode = "usage" | "capability" | "adapter" | "protocol";

/** MCP 信封中的错误载荷（§3.7；渲染同源两份见 §7） */
export interface ToolErrorBody {
  error: true;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** 内部抛出形态；MCP 层捕获后渲染为 ToolErrorBody */
export class DebugToolError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DebugToolError";
    this.code = code;
    this.details = details;
  }

  /** 序列化为 MCP 错误体 JSON 形态（§3.7）；与独立函数 toToolErrorBody 同源 */
  toToolErrorBody(): ToolErrorBody {
    return {
      error: true,
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/**
 * 把任意值渲染为 ToolErrorBody：`DebugToolError` 直映射；其余内部异常兜底折入
 * protocol（message = 异常 message），保证 isError 载荷永远四类之一（§3.7 注记）。
 */
export function toToolErrorBody(e: unknown): ToolErrorBody {
  if (e instanceof DebugToolError) return e.toToolErrorBody();
  const message = e instanceof Error ? e.message : String(e);
  return { error: true, code: "protocol", message };
}

// ── E-* 编号消息模板（api-contract §3.7 表）────────────────────────────

/** E-U1 的逐 issue 输入；path 为 zod issue 路径（数组形态） */
export interface ZodIssueLike {
  path: Array<string | number>;
  message: string;
}

/** E-U1：zod 校验失败；逐 issue 以 "; " 连接，path 用 "." 连接（根路径记作 "action"） */
export function invalidArgumentsError(issues: ZodIssueLike[]): DebugToolError {
  const join = (p: Array<string | number>): string => (p.length === 0 ? "action" : p.join("."));
  return new DebugToolError("usage", `invalid arguments: ${issues.map((i) => `${join(i.path)}: ${i.message}`).join("; ")}`, {
    issues: issues.map((i) => ({ path: join(i.path), message: i.message })),
  });
}

/** E-U2：未知 action；details.availableActions 为完整枚举 */
export function unknownActionError(action: string, availableActions: string[]): DebugToolError {
  return new DebugToolError("usage", `unknown action: ${action}`, { availableActions });
}

/** E-U3 的构造输入：候选适配器名与各自未中原因 */
export interface AdapterSelectionFailure {
  name: string;
  reason: string;
}

/** E-U3 主工厂：适配器选择全败；候选适配器名与各自未中原因逐条列出（DESIGN.md §4.4） */
export function adapterSelectionError(failures: AdapterSelectionFailure[]): DebugToolError {
  const list = failures.map((f) => `${f.name} (${f.reason})`).join("; ");
  return new DebugToolError("usage", `no debug adapter matched: ${list}`, { candidates: failures });
}

/** E-U3 变体：显式 adapter 未注册 */
export function unknownAdapterError(name: string, available: string[]): DebugToolError {
  return new DebugToolError("usage", `adapter '${name}' is not registered`, { availableAdapters: available });
}

/** E-U3 变体：attach 的 pid/port 二选一违例（api-contract §4.3 注记 3） */
export function attachTargetError(): DebugToolError {
  return new DebugToolError("usage", "attach requires exactly one of pid or port");
}

/** E-U3 变体：connect 型适配器 attach 需要既有 DAP server 端点（§4.4 attachConnection） */
export function attachConnectPortRequiredError(): DebugToolError {
  return new DebugToolError("usage", "connect-type adapter attach requires port (the existing DAP server endpoint)");
}

/** E-U4：sessionId 指定的会话不存在或已销毁 */
export function unknownSessionIdError(sessionId: string): DebugToolError {
  return new DebugToolError("usage", `unknown session id: ${sessionId}`);
}

/** E-U5：无会话时调用"作用于既有会话"的 action（精确字符串，DESIGN.md §5.1） */
export function noActiveSessionError(): DebugToolError {
  return new DebugToolError("usage", "No active debug session. Launch or attach first.");
}

/** E-U6：第二个并发根会话请求（精确字符串，DESIGN.md §5.1） */
export function busyRootSessionError(): DebugToolError {
  return new DebugToolError("usage", "busy: terminate existing session first");
}

/** E-U7：作用于目标会话的状态非法，说明缺失字段路径与修复建议 */
export function missingFieldError(field: string, hint: string): DebugToolError {
  return new DebugToolError("usage", `missing field '${field}': ${hint}`);
}

/** E-C1：capability 门控表中 action 所需能力缺失；不得发出注定失败的 DAP 请求 */
export function capabilityNotSupportedError(
  adapter: string,
  capability: string,
  description: string,
): DebugToolError {
  return new DebugToolError("capability", `'${adapter}' does not support ${description}`, {
    capability,
    adapter,
  });
}

/** E-A1 的构造输入：适配器命令解析/启动失败 */
export interface AdapterCommandFailureOptions {
  /** 期望解析/启动的命令名或路径 */
  command: string;
  /** spawn errno（如 ENOENT）或 commandResolution 候选皆败时的标记 */
  errno?: string;
  /** stderr 摘录（≤ 512 字符） */
  stderrExcerpt?: string;
  /** 配置的 installHint（commandResolution.installHint） */
  installHint?: string;
  /** 已尝试的候选路径（诊断） */
  attempted?: string[];
}

/** E-A1：适配器命令解析/启动失败（spawn ENOENT、commandResolution 候选皆败） */
export function adapterCommandError(opts: AdapterCommandFailureOptions): DebugToolError {
  const parts = [`adapter command '${opts.command}' could not be resolved`];
  if (opts.errno !== undefined) parts.push(`(${opts.errno})`);
  let message = parts.join(" ");
  if (opts.installHint !== undefined) message += `; install hint: ${opts.installHint}`;
  return new DebugToolError("adapter", message, {
    command: opts.command,
    ...(opts.errno !== undefined ? { errno: opts.errno } : {}),
    ...(opts.stderrExcerpt !== undefined ? { stderrExcerpt: opts.stderrExcerpt } : {}),
    ...(opts.installHint !== undefined ? { installHint: opts.installHint } : {}),
    ...(opts.attempted !== undefined ? { attempted: opts.attempted } : {}),
  });
}

/** E-A2 的构造输入：连接期失败（socket/tcp transport 就绪超时、TCP 连接被拒） */
export interface AdapterConnectionFailureOptions {
  /** transport 名（"stdio" | "socket" | "tcp"） */
  transport: string;
  /** 目标端点：unix socketPath 或 "host:port" */
  endpoint: string;
  /** 就绪等待时长（ms）；缺失时不入 message/details */
  readyTimeoutMs?: number;
  /** 附加原因（如 adapter exited / ECONNREFUSED / ENOENT） */
  reason?: string;
}

/** E-A2：连接期失败（socket/tcp transport 就绪超时、TCP 连接被拒）；details 含 transport/端点/就绪等待时长 */
export function adapterConnectionError(opts: AdapterConnectionFailureOptions): DebugToolError {
  const parts = [`${opts.transport} transport to ${opts.endpoint} was not ready`];
  if (opts.readyTimeoutMs !== undefined) parts.push(`after ${opts.readyTimeoutMs}ms`);
  if (opts.reason !== undefined) parts.push(`(${opts.reason})`);
  return new DebugToolError('adapter', parts.join(' '), {
    transport: opts.transport,
    endpoint: opts.endpoint,
    ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  });
}

/** E-A3：适配器进程在会话中途退出/崩溃；此后一切 pending 以同一类错误拒绝 */
export function adapterExitedError(
  sessionId: string,
  exitCode: number,
  stderrExcerpt?: string,
): DebugToolError {
  return new DebugToolError(
    "adapter",
    `'${sessionId}' adapter exited unexpectedly (exit code ${exitCode})`,
    { exitCode, ...(stderrExcerpt !== undefined ? { stderrExcerpt } : {}) },
  );
}

/** E-P1：DAP error response（适配器对请求回了 success:false）；message 前缀固定 */
export function requestFailedError(command: string, requestSeq: number, errorBody: unknown): DebugToolError {
  const raw =
    typeof errorBody === "string"
      ? errorBody
      : errorBody !== null && typeof errorBody === "object" &&
        typeof (errorBody as { message?: unknown }).message === "string"
        ? (errorBody as { message: string }).message
        : JSON.stringify(errorBody);
  return new DebugToolError("protocol", `DAP request '${command}' failed: ${raw}`, {
    command,
    requestSeq,
    body: errorBody,
  });
}

/** E-P2：单个 DAP 请求在 requestTimeoutMs 内未获响应（等待类 timeout 到期非错误） */
export function requestTimedOutError(command: string, timeoutMs: number): DebugToolError {
  return new DebugToolError("protocol", `DAP request '${command}' timed out after ${timeoutMs}ms`, {
    command,
  });
}
