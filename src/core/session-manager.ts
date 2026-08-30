/**
 * 会话管理器（DESIGN.md §5 固化，api-contract §4.6）——MCP 工具面的核心中枢。
 *
 * 自 oh-my-pi `dap/session.ts`（1877 行）移植去宿主化：
 *   - 构造函数依赖注入（clientFactory/registry/logger/settings），消除模块级单例与
 *     Bun/ptree/AbortSignal 宿主耦合；会话 id 改为 `<adapter>-<n>`（api-contract §4.7）；
 *   - DapClient 按 api-contract §4.2 接口消费（sendRequest/onEvent/onReverseRequest/
 *     isAlive/dispose/port），以 onEvent 自建事件等待（无 waitForEvent）；
 *   - 错误折叠遵循 Controller Ruling：E-P1/E-P2 由 client 层直透（不二次包装）；
 *     E-A3 在本层以 `adapterExitedError(sessionId, …)` 工厂重包装（补会话 id 前缀）；
 *     E-U3/E-A1/E-A2 由 registry/client/openTransport 抛出，本层直透。
 *
 * 职责：会话树（launch/attach 建根，startDebugging 派生子会话）、焦点与状态缓存、
 * Outcome 三态流控（先订后发）、四类断点（每会话 mutation 队列串行化 + 根断点全树同步）、
 * 输出环、生命周期时钟（cleanup/heartbeat）、runInTerminal 按 allowRunInTerminal 配置响应。
 * 所有返回经 `SessionSummary` 快照统一承载（§3.3）。
 */

import * as path from 'node:path';
import type { AdapterRegistry, ResolvedAdapter, Settings } from './adapter-registry.js';
import type { ClientFactory, DapClient } from './client.js';
import {
  adapterExitedError,
  busyRootSessionError,
  capabilityNotSupportedError,
  DebugToolError,
  missingFieldError,
  noActiveSessionError,
  unknownSessionIdError,
} from './errors.js';
import type { Logger } from './log.js';
import { spawnProcess, type SpawnedProcess } from './process.js';
import {
  CLIENT_INITIALIZE_ARGUMENTS_BASE,
  DEFAULT_TIMEOUT_MS,
  type CurrentStop,
  type DapBreakpoint,
  type DapCapabilities,
  type DapOutputEventBody,
  type DapRunInTerminalArguments,
  type DapRunInTerminalResponse,
  type DapStartDebuggingArguments,
  type DapStoppedEventBody,
  type DataBreakpointInfoResponse,
  type DataBreakpointRecord,
  type DisassembledInstruction,
  type EvaluateContext,
  type EvaluateResult,
  type FunctionBreakpointRecord,
  type InstructionBreakpointRecord,
  type Module,
  type Outcome,
  type Scope,
  type SessionStatus,
  type SessionSummary,
  type Source,
  type SourceBreakpointRecord,
  type StackFrame,
  type Thread,
  type Variable,
} from './protocol/types.js';

// ── 载荷类型（api-contract §4.6.3；方法返回值 == MCP 载荷）────────────────────

export interface LaunchPayload {
  snapshot: SessionSummary;
}
export interface AttachPayload {
  snapshot: SessionSummary;
}
export interface TerminatePayload {
  snapshot: SessionSummary | null;
}
export interface PausePayload {
  snapshot: SessionSummary;
}
export interface SessionsPayload {
  focusedSessionId: string | null;
  sessions: SessionSummary[];
}
export interface SetSourceBreakpointsPayload {
  snapshot: SessionSummary;
  file: string;
  breakpoints: SourceBreakpointRecord[];
}
export interface FunctionBreakpointsPayload {
  snapshot: SessionSummary;
  breakpoints: FunctionBreakpointRecord[];
}
export interface InstructionBreakpointsPayload {
  snapshot: SessionSummary;
  breakpoints: InstructionBreakpointRecord[];
}
export interface DataBreakpointsPayload {
  snapshot: SessionSummary;
  breakpoints: DataBreakpointRecord[];
}
export interface DataBreakpointInfoPayload {
  snapshot: SessionSummary;
  info: DataBreakpointInfoResponse;
}
export interface StackTracePayload {
  snapshot: SessionSummary;
  stackFrames: StackFrame[];
  totalFrames?: number;
}
export interface ThreadsPayload {
  snapshot: SessionSummary;
  threads: Thread[];
}
export interface ScopesPayload {
  snapshot: SessionSummary;
  scopes: Scope[];
}
export interface VariablesPayload {
  snapshot: SessionSummary;
  variables: Variable[];
}
export interface EvaluatePayload {
  snapshot: SessionSummary;
  evaluation: EvaluateResult;
}
export interface ExceptionInfoPayload {
  snapshot: SessionSummary;
  exception: { exceptionId: string; breakMode: string; [key: string]: unknown };
}
export interface OutputPayload {
  snapshot: SessionSummary;
  output: string;
}
export interface DisassemblePayload {
  snapshot: SessionSummary;
  instructions: DisassembledInstruction[];
}
export interface ReadMemoryPayload {
  snapshot: SessionSummary;
  address: string;
  data?: string;
  unreadableBytes?: number;
}
export interface WriteMemoryPayload {
  snapshot: SessionSummary;
  offset?: number;
  bytesWritten?: number;
}
export interface ModulesPayload {
  snapshot: SessionSummary;
  modules: Module[];
  totalModules?: number;
}
export interface LoadedSourcesPayload {
  snapshot: SessionSummary;
  sources: Source[];
}
export interface CustomRequestPayload {
  snapshot: SessionSummary;
  body: unknown;
}

// ── 输入/公共选项类型（api-contract §4.6.2）────────────────────────────────

export interface CallOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export interface StartOptions {
  timeoutMs?: number;
}

export interface LaunchInput {
  program: string;
  args?: string[];
  cwd?: string;
  adapter?: string;
  /** 调用方显式 DAP 请求体覆盖（DESIGN §4.1：最高优先层） */
  dapArguments?: Record<string, unknown>;
}

export interface AttachInput {
  pid?: number;
  port?: number;
  host?: string;
  cwd?: string;
  adapter?: string;
  /** 调用方显式 DAP 请求体覆盖（DESIGN §4.1：最高优先层） */
  dapArguments?: Record<string, unknown>;
}

export interface SessionManagerOptions {
  clientFactory: ClientFactory;
  registry: AdapterRegistry;
  logger: Logger;
  settings: Settings;
}

// ── 内部会话节点 ────────────────────────────────────────────────────────────

interface Session {
  id: string;
  adapter: ResolvedAdapter;
  cwd: string;
  program?: string;
  client: DapClient;
  status: SessionStatus;
  launchedAt: number;
  lastUsedAt: number;
  breakpoints: Map<string, SourceBreakpointRecord[]>;
  functionBreakpoints: FunctionBreakpointRecord[];
  instructionBreakpoints: InstructionBreakpointRecord[];
  dataBreakpoints: DataBreakpointRecord[];
  /** 断点 mutation 串行化队列（DESIGN.md §5.4；并发修改不得互丢） */
  breakpointMutationQueue: Promise<void>;
  outputChunks: string[];
  outputBytes: number;
  outputBufferedBytes: number;
  outputTruncated: boolean;
  stop: CurrentStop;
  threads: Thread[];
  lastStackFrames: StackFrame[];
  exitCode?: number;
  /** 终止时刻（宽限期起点，§5.1 生命周期）；仅 status === 'terminated' 时有意义 */
  terminatedAt?: number;
  capabilities?: DapCapabilities;
  initializedSeen: boolean;
  needsConfigurationDone: boolean;
  configurationDoneSent: boolean;
  parentSessionId?: string;
  childSessionIds: Set<string>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

interface TreeOutcomeWaiter {
  rootSessionId: string;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

interface StartRequestFailure {
  rejected: boolean;
  error?: unknown;
  settled?: Promise<void>;
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function trackDapStartRequest<T>(promise: Promise<T>, failure: StartRequestFailure): Promise<T> {
  const tracked = promise.catch((error) => {
    failure.rejected = true;
    failure.error = error;
    throw error;
  });
  failure.settled = tracked.then(
    () => {},
    () => {},
  );
  return tracked;
}

function combineDapStartErrors(command: 'launch' | 'attach', startError: unknown, configurationError: unknown): Error {
  const startMessage = toErrorMessage(startError);
  const configurationMessage = toErrorMessage(configurationError);
  if (startMessage === configurationMessage) {
    return startError instanceof Error ? startError : new Error(startMessage);
  }
  return new Error(
    `DAP ${command} failed: ${startMessage}\nDAP configurationDone also failed: ${configurationMessage}`,
  );
}

async function throwPreferredDapStartError(
  command: 'launch' | 'attach',
  startFailure: StartRequestFailure,
  configurationError: unknown,
): Promise<never> {
  await Promise.race([startFailure.settled ?? Promise.resolve(), sleep(50)]);
  if (startFailure.rejected) {
    throw combineDapStartErrors(command, startFailure.error, configurationError);
  }
  throw configurationError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

/** 输出环写入：累计字节历史总量；缓冲超出 maxOutputBytes 时整块从头部丢弃/字节切片保留尾部 */
function truncateOutput(session: Session, output: string, maxOutputBytes: number): void {
  if (!output) return;
  const bytes = Buffer.byteLength(output, 'utf-8');
  session.outputChunks.push(output);
  session.outputBytes += bytes;
  session.outputBufferedBytes += bytes;
  while (session.outputChunks.length > 1) {
    const frontBytes = Buffer.byteLength(session.outputChunks[0], 'utf-8');
    if (session.outputBufferedBytes - frontBytes < maxOutputBytes) break;
    session.outputChunks.shift();
    session.outputBufferedBytes -= frontBytes;
    session.outputTruncated = true;
  }
  if (session.outputBufferedBytes > maxOutputBytes) {
    const front = session.outputChunks[0];
    const frontBytes = Buffer.byteLength(front, 'utf-8');
    const excess = session.outputBufferedBytes - maxOutputBytes;
    const kept = Buffer.from(front, 'utf-8').subarray(excess).toString('utf-8');
    session.outputChunks[0] = kept;
    session.outputBufferedBytes += Buffer.byteLength(kept, 'utf-8') - frontBytes;
    session.outputTruncated = true;
  }
}

function summarizeBreakpointCount(breakpoints: Map<string, SourceBreakpointRecord[]>): number {
  let total = 0;
  for (const entries of breakpoints.values()) {
    total += entries.length;
  }
  return total;
}

function buildSummary(session: Session): SessionSummary {
  return {
    id: session.id,
    adapter: session.adapter.name,
    cwd: session.cwd,
    ...(session.program !== undefined ? { program: session.program } : {}),
    status: session.status,
    launchedAt: new Date(session.launchedAt).toISOString(),
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    ...(session.stop.threadId !== undefined ? { threadId: session.stop.threadId } : {}),
    ...(session.stop.frameId !== undefined ? { frameId: session.stop.frameId } : {}),
    ...(session.stop.reason !== undefined ? { stopReason: session.stop.reason } : {}),
    ...(session.stop.description !== undefined || session.stop.text !== undefined
      ? { stopDescription: session.stop.description ?? session.stop.text }
      : {}),
    ...(session.stop.frameName !== undefined ? { frameName: session.stop.frameName } : {}),
    ...(session.stop.instructionPointerReference !== undefined
      ? { instructionPointerReference: session.stop.instructionPointerReference }
      : {}),
    ...(session.stop.source !== undefined ? { source: session.stop.source } : {}),
    ...(session.stop.line !== undefined ? { line: session.stop.line } : {}),
    ...(session.stop.column !== undefined ? { column: session.stop.column } : {}),
    breakpointFiles: session.breakpoints.size,
    breakpointCount: summarizeBreakpointCount(session.breakpoints),
    functionBreakpointCount: session.functionBreakpoints.length,
    outputBytes: session.outputBytes,
    outputTruncated: session.outputTruncated,
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    needsConfigurationDone: session.needsConfigurationDone && !session.configurationDoneSent,
    ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.childSessionIds.size > 0 ? { childSessionIds: [...session.childSessionIds] } : {}),
  };
}

// ── 能力门控表（api-contract §6）───────────────────────────────────────────

interface CapabilityGate {
  field: string;
  description: string;
}

const CAPABILITY_GATES: Record<string, CapabilityGate> = {
  function: { field: 'supportsFunctionBreakpoints', description: 'function breakpoints' },
  instruction: { field: 'supportsInstructionBreakpoints', description: 'instruction breakpoints' },
  data: { field: 'supportsDataBreakpoints', description: 'data breakpoints' },
  disassemble: { field: 'supportsDisassembleRequest', description: 'disassemble requests' },
  readMemory: { field: 'supportsReadMemoryRequest', description: 'readMemory requests' },
  writeMemory: { field: 'supportsWriteMemoryRequest', description: 'writeMemory requests' },
  modules: { field: 'supportsModulesRequest', description: 'modules requests' },
  loadedSources: { field: 'supportsLoadedSourcesRequest', description: 'loadedSources requests' },
};

export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #treeOutcomeWaiters = new Set<TreeOutcomeWaiter>();
  readonly #memberSeqByRoot = new Map<string, number>();
  readonly #clientFactory: ClientFactory;
  readonly #registry: AdapterRegistry;
  readonly #logger: Logger;
  readonly #settings: Settings;
  #activeSessionId: string | null = null;
  #rootSeq = 0;
  #cleanupTimer?: ReturnType<typeof setInterval>;
  #disposed = false;
  /** 根启动占位（I-1）：launch/attach 在 #ensureLaunchSlot 通过后到根注册/失败前持有，
   *  使 clientFactory 挂起窗口（socket/tcp 就绪等待）内的第二个并发根请求仍被 E-U6 拒绝 */
  #startingRoot = false;

  constructor(options: SessionManagerOptions) {
    this.#clientFactory = options.clientFactory;
    this.#registry = options.registry;
    this.#logger = options.logger;
    this.#settings = options.settings;
    this.#startCleanupTimer();
  }

  // ── 会话 ──────────────────────────────────────────────────────────────

  async launch(input: LaunchInput, opts?: StartOptions): Promise<LaunchPayload> {
    this.#ensureLaunchSlot();
    try {
      const cwd = path.resolve(input.cwd ?? process.cwd());
      const resolution = this.#registry.resolveLaunch({
        program: input.program,
        cwd,
        ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.dapArguments !== undefined ? { dapArguments: input.dapArguments } : {}),
      });
      // 调用方显式 timeoutMs 优先（§4.1）；缺省以 settings.requestTimeoutMs 兜底，
      // 启动请求与握手等待共用同一预算（§7.1：到期不是错误，经 startFailure 兜底结算）
      const timeoutMs = opts?.timeoutMs ?? this.#settings.requestTimeoutMs;
      const client = await this.#clientFactory({
        adapter: resolution.adapter,
        cwd,
        connection: { kind: 'spawn' },
        requestTimeoutMs: this.#settings.requestTimeoutMs,
      });
      const program = typeof resolution.launchArguments.program === 'string' ? resolution.launchArguments.program : undefined;
      const session = this.#registerSession(client, resolution.adapter, cwd, program);
      try {
        session.capabilities = await this.#sendInitialize(client, resolution.adapter);
        session.needsConfigurationDone = session.capabilities.supportsConfigurationDoneRequest === true;
        const initialStopPromise = this.#prepareStopOutcome(
          session,
          Math.min(timeoutMs, this.#settings.stopCaptureTimeoutMs),
        );
        const startFailure: StartRequestFailure = { rejected: false };
        const startPromise = trackDapStartRequest(
          client.sendRequest('launch', resolution.launchArguments, timeoutMs),
          startFailure,
        );
        startPromise.catch(() => {});
        try {
          await this.#completeConfigurationHandshake(session, timeoutMs);
        } catch (error) {
          await throwPreferredDapStartError('launch', startFailure, error);
        }
        await startPromise;
        let resultSession = session;
        try {
          await initialStopPromise;
          const active = this.#getActiveSessionOrNull();
          if (active && this.#getRootSession(active).id === session.id) {
            resultSession = active;
          }
          if (resultSession.status === 'stopped') {
            await this.#fetchTopFrame(resultSession, Math.min(timeoutMs, this.#settings.stopCaptureTimeoutMs));
          }
        } catch {
          if (session.initializedSeen && session.status === 'launching') {
            session.status = session.configurationDoneSent ? 'running' : 'configuring';
          }
        }
        return { snapshot: buildSummary(resultSession) };
      } catch (error) {
        await this.#disposeSession(session);
        // 启动/握手路径的 client 层 E-A3（无前缀）须以会话 id 重包装（Ruling 1）
        throw this.#rewrapAdapterError(session, error);
      }
    } finally {
      this.#startingRoot = false;
    }
  }

  async attach(input: AttachInput, opts?: StartOptions): Promise<AttachPayload> {
    this.#ensureLaunchSlot();
    try {
      const cwd = path.resolve(input.cwd ?? process.cwd());
      const resolution = this.#registry.resolveAttach({
        cwd,
        ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
        ...(input.pid !== undefined ? { pid: input.pid } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.host !== undefined ? { host: input.host } : {}),
        ...(input.dapArguments !== undefined ? { dapArguments: input.dapArguments } : {}),
      });
      // 调用方显式 timeoutMs 优先（§4.1）；缺省以 settings.requestTimeoutMs 兜底，
      // 启动请求与握手等待共用同一预算（§7.1：到期不是错误，经 startFailure 兜底结算）
      const timeoutMs = opts?.timeoutMs ?? this.#settings.requestTimeoutMs;
      // connection 由 registry 依记录 attachConnection 决定（§4.4）：spawn 拉起 / tcp 复连既有 DAP server
      const client = await this.#clientFactory({
        adapter: resolution.adapter,
        cwd,
        connection: resolution.connection,
        requestTimeoutMs: this.#settings.requestTimeoutMs,
      });
      const session = this.#registerSession(client, resolution.adapter, cwd);
      try {
        session.capabilities = await this.#sendInitialize(client, resolution.adapter);
        session.needsConfigurationDone = session.capabilities.supportsConfigurationDoneRequest === true;
        const initialStopPromise = this.#prepareStopOutcome(
          session,
          Math.min(timeoutMs, this.#settings.stopCaptureTimeoutMs),
        );
        const startFailure: StartRequestFailure = { rejected: false };
        const startPromise = trackDapStartRequest(
          client.sendRequest('attach', resolution.attachArguments, timeoutMs),
          startFailure,
        );
        startPromise.catch(() => {});
        try {
          await this.#completeConfigurationHandshake(session, timeoutMs);
        } catch (error) {
          await throwPreferredDapStartError('attach', startFailure, error);
        }
        await startPromise;
        let resultSession = session;
        try {
          await initialStopPromise;
          const active = this.#getActiveSessionOrNull();
          if (active && this.#getRootSession(active).id === session.id) {
            resultSession = active;
          }
          if (resultSession.status === 'stopped') {
            await this.#fetchTopFrame(resultSession, Math.min(timeoutMs, this.#settings.stopCaptureTimeoutMs));
          }
        } catch {
          if (session.initializedSeen && session.status === 'launching') {
            session.status = session.configurationDoneSent ? 'running' : 'configuring';
          }
        }
        return { snapshot: buildSummary(resultSession) };
      } catch (error) {
        await this.#disposeSession(session);
        // 启动/握手路径的 client 层 E-A3（无前缀）须以会话 id 重包装（Ruling 1）
        throw this.#rewrapAdapterError(session, error);
      }
    } finally {
      this.#startingRoot = false;
    }
  }

  async terminate(opts?: CallOptions): Promise<TerminatePayload> {
    const target = this.#resolveTargetForTerminate(opts);
    if (!target) return { snapshot: null };
    this.#touchSessionAndAncestors(target);
    const root = this.#getRootSession(target);
    const snapshot = buildSummary(target);
    await this.#terminateSessionTree(root);
    return { snapshot };
  }

  sessions(): SessionsPayload {
    return {
      focusedSessionId: this.#activeSessionId,
      sessions: [...this.#sessions.values()].map(buildSummary),
    };
  }

  // ── 断点 ──────────────────────────────────────────────────────────────

  async setBreakpoint(
    file: string,
    line: number,
    condition?: string,
    hitCondition?: string,
    opts?: CallOptions,
  ): Promise<SetSourceBreakpointsPayload> {
    const session = this.#resolveTarget(opts);
    const sourcePath = normalizePath(file);
    const root = this.#getRootSession(session);
    const current = [...(root.breakpoints.get(sourcePath) ?? [])].filter((entry) => entry.line !== line);
    current.push({
      verified: false,
      line,
      ...(condition !== undefined ? { condition } : {}),
      ...(hitCondition !== undefined ? { hitCondition } : {}),
    });
    current.sort((left, right) => left.line - right.line);
    const args = {
      source: { path: sourcePath },
      breakpoints: current.map<Record<string, unknown>>((entry) => ({
        line: entry.line,
        ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
        ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
      })),
    };
    await this.#syncBreakpointTree(
      session,
      'setBreakpoints',
      args,
      (target) => {
        target.breakpoints.set(
          sourcePath,
          current.map((entry) => ({ ...entry, verified: false })),
        );
      },
      (target, response) => {
        target.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(current, response));
      },
    );
    return {
      snapshot: buildSummary(session),
      file: sourcePath,
      breakpoints: session.breakpoints.get(sourcePath) ?? [],
    };
  }

  async removeBreakpoint(file: string, line: number, opts?: CallOptions): Promise<SetSourceBreakpointsPayload> {
    const session = this.#resolveTarget(opts);
    const sourcePath = normalizePath(file);
    const root = this.#getRootSession(session);
    const current = [...(root.breakpoints.get(sourcePath) ?? [])].filter((entry) => entry.line !== line);
    const args = {
      source: { path: sourcePath },
      breakpoints: current.map<Record<string, unknown>>((entry) => ({
        line: entry.line,
        ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
        ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
      })),
    };
    const prepare = (target: Session): void => {
      if (current.length === 0) target.breakpoints.delete(sourcePath);
      else
        target.breakpoints.set(
          sourcePath,
          current.map((entry) => ({ ...entry, verified: false })),
        );
    };
    await this.#syncBreakpointTree(
      session,
      'setBreakpoints',
      args,
      prepare,
      (target, response) => {
        if (current.length === 0) target.breakpoints.delete(sourcePath);
        else target.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(current, response));
      },
    );
    return {
      snapshot: buildSummary(session),
      file: sourcePath,
      breakpoints: session.breakpoints.get(sourcePath) ?? [],
    };
  }

  async setFunctionBreakpoint(
    name: string,
    condition?: string,
    hitCondition?: string,
    opts?: CallOptions,
  ): Promise<FunctionBreakpointsPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'function');
    const current = this.#getRootSession(session).functionBreakpoints.filter((entry) => entry.name !== name);
    current.push({
      verified: false,
      name,
      ...(condition !== undefined ? { condition } : {}),
      ...(hitCondition !== undefined ? { hitCondition } : {}),
    });
    current.sort((left, right) => left.name.localeCompare(right.name));
    const args = {
      breakpoints: current.map<Record<string, unknown>>((entry) => ({
        name: entry.name,
        ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
        ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
      })),
    };
    await this.#syncBreakpointTree(
      session,
      'setFunctionBreakpoints',
      args,
      (target) => {
        target.functionBreakpoints = current.map((entry) => ({ ...entry, verified: false }));
      },
      (target, response) => {
        target.functionBreakpoints = this.#mapFunctionBreakpoints(current, response);
      },
    );
    return { snapshot: buildSummary(session), breakpoints: session.functionBreakpoints };
  }

  async removeFunctionBreakpoint(name: string, opts?: CallOptions): Promise<FunctionBreakpointsPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'function');
    const current = this.#getRootSession(session).functionBreakpoints.filter((entry) => entry.name !== name);
    const args = {
      breakpoints: current.map<Record<string, unknown>>((entry) => ({
        name: entry.name,
        ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
        ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
      })),
    };
    await this.#syncBreakpointTree(
      session,
      'setFunctionBreakpoints',
      args,
      (target) => {
        target.functionBreakpoints = current.map((entry) => ({ ...entry, verified: false }));
      },
      (target, response) => {
        target.functionBreakpoints = this.#mapFunctionBreakpoints(current, response);
      },
    );
    return { snapshot: buildSummary(session), breakpoints: session.functionBreakpoints };
  }

  async setInstructionBreakpoint(
    instructionReference: string,
    offset?: number,
    condition?: string,
    opts?: CallOptions,
  ): Promise<InstructionBreakpointsPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'instruction');
    const current = this.#getRootSession(session).instructionBreakpoints.filter(
      (entry) => entry.instructionReference !== instructionReference || entry.offset !== offset,
    );
    current.push({
      verified: false,
      instructionReference,
      ...(offset !== undefined ? { offset } : {}),
      ...(condition !== undefined ? { condition } : {}),
    });
    current.sort((left, right) => {
      const referenceOrder = left.instructionReference.localeCompare(right.instructionReference);
      return referenceOrder !== 0 ? referenceOrder : (left.offset ?? 0) - (right.offset ?? 0);
    });
    const args = { breakpoints: this.#instructionBreakpointsToDap(current) };
    let responseBreakpoints: DapBreakpoint[] | undefined;
    await this.#syncBreakpointTree(
      session,
      'setInstructionBreakpoints',
      args,
      (target) => {
        target.instructionBreakpoints = current.map((entry) => ({ ...entry }));
      },
      (target, response) => {
        if (target === session) responseBreakpoints = response;
      },
    );
    return {
      snapshot: buildSummary(session),
      breakpoints: this.#mapInstructionBreakpoints(current, responseBreakpoints),
    };
  }

  async removeInstructionBreakpoint(
    instructionReference: string,
    offset?: number,
    opts?: CallOptions,
  ): Promise<InstructionBreakpointsPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'instruction');
    const current = this.#getRootSession(session).instructionBreakpoints.filter((entry) => {
      if (entry.instructionReference !== instructionReference) return true;
      return offset !== undefined && entry.offset !== offset;
    });
    const args = { breakpoints: this.#instructionBreakpointsToDap(current) };
    let responseBreakpoints: DapBreakpoint[] | undefined;
    await this.#syncBreakpointTree(
      session,
      'setInstructionBreakpoints',
      args,
      (target) => {
        target.instructionBreakpoints = current.map((entry) => ({ ...entry }));
      },
      (target, response) => {
        if (target === session) responseBreakpoints = response;
      },
    );
    return {
      snapshot: buildSummary(session),
      breakpoints: this.#mapInstructionBreakpoints(current, responseBreakpoints),
    };
  }

  async dataBreakpointInfo(
    name?: string,
    variablesReference?: number,
    opts?: CallOptions,
  ): Promise<DataBreakpointInfoPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'data');
    const info = await this.#sendRequestWithConfig<DataBreakpointInfoResponse>(session, 'dataBreakpointInfo', {
      ...(name !== undefined ? { name } : {}),
      ...(variablesReference !== undefined ? { variablesReference } : {}),
      ...(session.stop.frameId !== undefined ? { frameId: session.stop.frameId } : {}),
    });
    return { snapshot: buildSummary(session), info };
  }

  async setDataBreakpoint(
    dataId: string,
    accessType?: 'read' | 'write' | 'readWrite',
    condition?: string,
    opts?: CallOptions,
  ): Promise<DataBreakpointsPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'data');
    const current = this.#getRootSession(session).dataBreakpoints.filter((entry) => entry.dataId !== dataId);
    current.push({
      verified: false,
      dataId,
      ...(accessType !== undefined ? { accessType } : {}),
      ...(condition !== undefined ? { condition } : {}),
    });
    current.sort((left, right) => left.dataId.localeCompare(right.dataId));
    const args = { breakpoints: this.#dataBreakpointsToDap(current) };
    let responseBreakpoints: DapBreakpoint[] | undefined;
    await this.#syncBreakpointTree(
      session,
      'setDataBreakpoints',
      args,
      (target) => {
        target.dataBreakpoints = current.map((entry) => ({ ...entry }));
      },
      (target, response) => {
        if (target === session) responseBreakpoints = response;
      },
    );
    return {
      snapshot: buildSummary(session),
      breakpoints: this.#mapDataBreakpoints(current, responseBreakpoints),
    };
  }

  async removeDataBreakpoint(dataId: string, opts?: CallOptions): Promise<DataBreakpointsPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'data');
    const current = this.#getRootSession(session).dataBreakpoints.filter((entry) => entry.dataId !== dataId);
    const args = { breakpoints: this.#dataBreakpointsToDap(current) };
    let responseBreakpoints: DapBreakpoint[] | undefined;
    await this.#syncBreakpointTree(
      session,
      'setDataBreakpoints',
      args,
      (target) => {
        target.dataBreakpoints = current.map((entry) => ({ ...entry }));
      },
      (target, response) => {
        if (target === session) responseBreakpoints = response;
      },
    );
    return {
      snapshot: buildSummary(session),
      breakpoints: this.#mapDataBreakpoints(current, responseBreakpoints),
    };
  }

  // ── 流控 ──────────────────────────────────────────────────────────────

  async continue(threadId?: number, opts?: CallOptions): Promise<Outcome> {
    const session = this.#resolveTarget(opts);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const resolvedThreadId = await this.#resolveThreadId(session, timeoutMs);
    session.stop = {};
    session.lastStackFrames = [];
    session.status = 'running';
    const outcomePromise = this.#prepareStopOutcome(session, timeoutMs);
    await this.#sendRequestWithConfig(session, 'continue', { threadId: resolvedThreadId });
    return this.#awaitStopOutcome(session, outcomePromise, timeoutMs);
  }

  async pause(threadId?: number, opts?: CallOptions): Promise<PausePayload> {
    const session = this.#resolveTarget(opts);
    // status 会在事件分发与 await 之间被改写；经闭包读取避免 TS 陈旧窄化（移植源同构）
    const isStopped = (): boolean => session.status === 'stopped';
    if (isStopped()) {
      return { snapshot: buildSummary(session) };
    }
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const resolvedThreadId = await this.#resolveThreadId(session, timeoutMs);
    const stoppedPromise = this.#waitForEvent(
      session,
      'stopped',
      Math.min(timeoutMs, this.#settings.requestTimeoutMs),
    );
    stoppedPromise.catch(() => {});
    await this.#sendRequestWithConfig(session, 'pause', { threadId: resolvedThreadId });
    if (!isStopped()) {
      try {
        await stoppedPromise;
      } catch {
        // Timeout — report current state regardless.
      }
    }
    return { snapshot: buildSummary(session) };
  }

  async stepOver(threadId?: number, opts?: CallOptions): Promise<Outcome> {
    return this.#step('next', threadId, opts);
  }

  async stepIn(threadId?: number, opts?: CallOptions): Promise<Outcome> {
    return this.#step('stepIn', threadId, opts);
  }

  async stepOut(threadId?: number, opts?: CallOptions): Promise<Outcome> {
    return this.#step('stepOut', threadId, opts);
  }

  // ── 检查 ──────────────────────────────────────────────────────────────

  async stackTrace(threadId?: number, levels?: number, opts?: CallOptions): Promise<StackTracePayload> {
    const session = this.#resolveTarget(opts);
    const resolvedThreadId = threadId ?? session.stop.threadId ?? session.threads[0]?.id;
    const response = await this.#sendRequestWithConfig<{ stackFrames?: StackFrame[]; totalFrames?: number }>(
      session,
      'stackTrace',
      {
        ...(resolvedThreadId !== undefined ? { threadId: resolvedThreadId } : {}),
        ...(levels !== undefined ? { levels } : {}),
      },
    );
    session.lastStackFrames = response?.stackFrames ?? [];
    this.#applyTopFrame(session, session.lastStackFrames[0]);
    return {
      snapshot: buildSummary(session),
      stackFrames: session.lastStackFrames,
      totalFrames: response?.totalFrames,
    };
  }

  async threads(opts?: CallOptions): Promise<ThreadsPayload> {
    const anchor = this.#resolveTarget(opts);
    const targets = this.#liveTreeSessions(anchor);
    const merged: Thread[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      let threads: Thread[];
      try {
        const response = await this.#sendRequestWithConfig<{ threads?: Thread[] }>(target, 'threads', undefined);
        threads = response?.threads ?? [];
      } catch (error) {
        // 会话消亡类（E-A3）拒绝该操作；其余个体失败降级跳过（§4.6.7-5）
        if (error instanceof Error && (error as { code?: string }).code === 'adapter') throw error;
        this.#logger.warn('Failed to list threads for debug session', {
          sessionId: target.id,
          error: toErrorMessage(error),
        });
        continue;
      }
      target.threads = threads;
      for (const thread of threads) {
        const key = `${target.id}\u0000${thread.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(thread);
      }
    }
    return { snapshot: buildSummary(anchor), threads: merged };
  }

  async scopes(frameId?: number, opts?: CallOptions): Promise<ScopesPayload> {
    const session = this.#resolveTarget(opts);
    const resolvedFrameId = frameId ?? session.stop.frameId;
    if (resolvedFrameId === undefined) {
      throw missingFieldError('frameId', 'Run stack_trace first or supply frame_id.');
    }
    const response = await this.#sendRequestWithConfig<{ scopes?: Scope[] }>(session, 'scopes', {
      frameId: resolvedFrameId,
    });
    return { snapshot: buildSummary(session), scopes: response?.scopes ?? [] };
  }

  async variables(
    variablesReference: number,
    start?: number,
    count?: number,
    opts?: CallOptions,
  ): Promise<VariablesPayload> {
    const session = this.#resolveTarget(opts);
    const response = await this.#sendRequestWithConfig<{ variables?: Variable[] }>(session, 'variables', {
      variablesReference,
      ...(start !== undefined ? { start } : {}),
      ...(count !== undefined ? { count } : {}),
    });
    return { snapshot: buildSummary(session), variables: response?.variables ?? [] };
  }

  async evaluate(
    expression: string,
    frameId?: number,
    context?: EvaluateContext,
    opts?: CallOptions,
  ): Promise<EvaluatePayload> {
    const session = this.#resolveTarget(opts);
    const effectiveFrameId = frameId ?? session.stop.frameId;
    if (effectiveFrameId === undefined) {
      throw missingFieldError('frameId', 'Run stack_trace first or supply frame_id.');
    }
    const response = await this.#sendRequestWithConfig<EvaluateResult>(session, 'evaluate', {
      expression,
      ...(context !== undefined ? { context } : {}),
      frameId: effectiveFrameId,
    });
    return { snapshot: buildSummary(session), evaluation: response };
  }

  async exceptionInfo(threadId?: number, opts?: CallOptions): Promise<ExceptionInfoPayload> {
    const session = this.#resolveTarget(opts);
    const effectiveThreadId = threadId ?? session.stop.threadId;
    if (effectiveThreadId === undefined) {
      throw missingFieldError('threadId', 'Run stack_trace first or supply thread_id.');
    }
    const response = await this.#sendRequestWithConfig<ExceptionInfoPayload['exception']>(
      session,
      'exceptionInfo',
      { threadId: effectiveThreadId },
    );
    return { snapshot: buildSummary(session), exception: response };
  }

  async output(tail?: number, opts?: CallOptions): Promise<OutputPayload> {
    const session = this.#resolveTarget(opts);
    const output = session.outputChunks.join('');
    if (!tail || tail <= 0 || session.outputBufferedBytes <= tail) {
      return { snapshot: buildSummary(session), output };
    }
    const buffer = Buffer.from(output, 'utf-8');
    if (buffer.length <= tail) {
      return { snapshot: buildSummary(session), output };
    }
    return { snapshot: buildSummary(session), output: buffer.subarray(buffer.length - tail).toString('utf-8') };
  }

  // ── 底层 ──────────────────────────────────────────────────────────────

  async disassemble(
    memoryReference: string,
    instructionCount: number = 64,
    instructionOffset?: number,
    offset?: number,
    resolveSymbols?: boolean,
    opts?: CallOptions,
  ): Promise<DisassemblePayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'disassemble');
    const response = await this.#sendRequestWithConfig<{ instructions?: DisassembledInstruction[] }>(
      session,
      'disassemble',
      {
        memoryReference,
        instructionCount,
        ...(instructionOffset !== undefined ? { instructionOffset } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(resolveSymbols !== undefined ? { resolveSymbols } : {}),
      },
    );
    return { snapshot: buildSummary(session), instructions: response?.instructions ?? [] };
  }

  async readMemory(
    memoryReference: string,
    count: number = 256,
    offset?: number,
    opts?: CallOptions,
  ): Promise<ReadMemoryPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'readMemory');
    const response = await this.#sendRequestWithConfig<{
      address?: string;
      data?: string;
      unreadableBytes?: number;
    }>(session, 'readMemory', {
      memoryReference,
      count,
      ...(offset !== undefined ? { offset } : {}),
    });
    return {
      snapshot: buildSummary(session),
      address: response?.address ?? memoryReference,
      data: response?.data,
      unreadableBytes: response?.unreadableBytes,
    };
  }

  async writeMemory(
    memoryReference: string,
    data: string,
    offset?: number,
    opts?: CallOptions,
  ): Promise<WriteMemoryPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'writeMemory');
    const response = await this.#sendRequestWithConfig<{ offset?: number; bytesWritten?: number }>(
      session,
      'writeMemory',
      {
        memoryReference,
        data,
        ...(offset !== undefined ? { offset } : {}),
      },
    );
    return { snapshot: buildSummary(session), ...(response ?? {}) };
  }

  async modules(startModule?: number, moduleCount?: number, opts?: CallOptions): Promise<ModulesPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'modules');
    const response = await this.#sendRequestWithConfig<{ modules?: Module[]; totalModules?: number }>(
      session,
      'modules',
      {
        ...(startModule !== undefined ? { startModule } : {}),
        ...(moduleCount !== undefined ? { moduleCount } : {}),
      },
    );
    return {
      snapshot: buildSummary(session),
      modules: response?.modules ?? [],
      ...(response?.totalModules !== undefined ? { totalModules: response.totalModules } : {}),
    };
  }

  async loadedSources(opts?: CallOptions): Promise<LoadedSourcesPayload> {
    const session = this.#resolveTarget(opts);
    this.#assertCapability(session, 'loadedSources');
    const response = await this.#sendRequestWithConfig<{ sources?: Source[] }>(session, 'loadedSources', {});
    return { snapshot: buildSummary(session), sources: response?.sources ?? [] };
  }

  async customRequest(
    command: string,
    args?: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<CustomRequestPayload> {
    const session = this.#resolveTarget(opts);
    const body = await this.#sendRequestWithConfig<unknown>(session, command, args);
    return { snapshot: buildSummary(session), body };
  }

  /** stdin EOF/shutdown 入口：停清扫循环，整树 terminate + 进程强杀兜底（§4.6.1） */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = undefined;
    }
    for (const root of [...this.#sessions.values()].filter((s) => !s.parentSessionId)) {
      await this.#terminateSessionTree(root);
    }
    this.#sessions.clear();
    this.#activeSessionId = null;
    this.#treeOutcomeWaiters.clear();
  }

  // ── 断点树同步与 mutation 队列 ─────────────────────────────────────────

  /** 每会话断点 mutation 串行化：读-改-写环绕 await，并发不得互丢（DESIGN.md §5.4） */
  #serializeBreakpointMutation<T>(session: Session, mutate: () => Promise<T>): Promise<T> {
    const run = session.breakpointMutationQueue.then(() => mutate());
    session.breakpointMutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 根断点集合是唯一权威：根执行成功后并行扇出到各存活子会话（§4.6.7-10） */
  async #syncBreakpointTree(
    origin: Session,
    command: string,
    args: Record<string, unknown>,
    prepare: (session: Session) => void,
    apply: (session: Session, response: DapBreakpoint[] | undefined) => void,
  ): Promise<void> {
    const sessions = this.#getTreeSessions(origin).filter(
      (session) => session.status !== 'terminated' && session.client.isAlive(),
    );
    for (const session of sessions) prepare(session);
    await this.#serializeBreakpointMutation(origin, async () => {
      const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
        origin,
        command,
        args,
      );
      apply(origin, response?.breakpoints);
    });
    await Promise.all(
      sessions
        .filter((session) => session !== origin)
        .map(async (session) => {
          try {
            await this.#serializeBreakpointMutation(session, async () => {
              const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
                session,
                command,
                args,
              );
              apply(session, response?.breakpoints);
            });
          } catch (error) {
            this.#logger.warn('Failed to synchronize breakpoint request with child debug session', {
              sessionId: session.id,
              command,
              error: toErrorMessage(error),
            });
          }
        }),
    );
  }

  /** 子会话建立时主动套用根的全部现有断点（§4.6.6） */
  async #applyRootBreakpointsToSession(session: Session, _timeoutMs: number): Promise<void> {
    const root = this.#getRootSession(session);
    for (const [sourcePath, entries] of root.breakpoints) {
      try {
        const response = await session.client.sendRequest<{ breakpoints?: DapBreakpoint[] }>(
          'setBreakpoints',
          {
            source: { path: sourcePath },
            breakpoints: entries.map<Record<string, unknown>>((entry) => ({
              line: entry.line,
              ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
              ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
            })),
          },
          this.#settings.requestTimeoutMs,
        );
        session.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(entries, response?.breakpoints));
      } catch (error) {
        this.#logger.warn('Failed to bind source breakpoints in child debug session', {
          sessionId: session.id,
          sourcePath,
          error: toErrorMessage(error),
        });
      }
    }
    if (root.functionBreakpoints.length > 0) {
      try {
        const response = await session.client.sendRequest<{ breakpoints?: DapBreakpoint[] }>(
          'setFunctionBreakpoints',
          {
            breakpoints: root.functionBreakpoints.map<Record<string, unknown>>((entry) => ({
              name: entry.name,
              ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
              ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
            })),
          },
          this.#settings.requestTimeoutMs,
        );
        session.functionBreakpoints = this.#mapFunctionBreakpoints(root.functionBreakpoints, response?.breakpoints);
      } catch (error) {
        this.#logger.warn('Failed to bind function breakpoints in child debug session', {
          sessionId: session.id,
          error: toErrorMessage(error),
        });
      }
    }
    if (root.instructionBreakpoints.length > 0) {
      try {
        await session.client.sendRequest(
          'setInstructionBreakpoints',
          { breakpoints: this.#instructionBreakpointsToDap(root.instructionBreakpoints) },
          this.#settings.requestTimeoutMs,
        );
        session.instructionBreakpoints = root.instructionBreakpoints.map((entry) => ({ ...entry }));
      } catch (error) {
        this.#logger.warn('Failed to bind instruction breakpoints in child debug session', {
          sessionId: session.id,
          error: toErrorMessage(error),
        });
      }
    }
    if (root.dataBreakpoints.length > 0) {
      try {
        await session.client.sendRequest(
          'setDataBreakpoints',
          { breakpoints: this.#dataBreakpointsToDap(root.dataBreakpoints) },
          this.#settings.requestTimeoutMs,
        );
        session.dataBreakpoints = root.dataBreakpoints.map((entry) => ({ ...entry }));
      } catch (error) {
        this.#logger.warn('Failed to bind data breakpoints in child debug session', {
          sessionId: session.id,
          error: toErrorMessage(error),
        });
      }
    }
  }

  // ── 流控内部 ──────────────────────────────────────────────────────────

  async #step(command: 'next' | 'stepIn' | 'stepOut', threadId?: number, opts?: CallOptions): Promise<Outcome> {
    const session = this.#resolveTarget(opts);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const resolvedThreadId = await this.#resolveThreadId(session, timeoutMs);
    session.stop = {};
    session.lastStackFrames = [];
    session.status = 'running';
    const outcomePromise = this.#prepareStopOutcome(session, timeoutMs);
    await this.#sendRequestWithConfig(session, command, { threadId: resolvedThreadId });
    return this.#awaitStopOutcome(session, outcomePromise, timeoutMs);
  }

  /**
   * 先订后发的整树 outcome 等待（DESIGN.md §5.3）：stopped/terminated/exited 任一
   * 事件结算当前树；超时由等待窗拒绝（非错误，回落 running）。
   */
  #prepareStopOutcome(session: Session, timeoutMs: number): Promise<unknown> {
    let resolvePromise!: (value: unknown) => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const rootSessionId = this.#getRootSession(session).id;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      this.#treeOutcomeWaiters.delete(waiter);
    };
    const waiter: TreeOutcomeWaiter = {
      rootSessionId,
      resolve: (value) => {
        cleanup();
        resolvePromise(value);
      },
      reject: (reason) => {
        cleanup();
        rejectPromise(reason);
      },
    };
    this.#treeOutcomeWaiters.add(waiter);
    timeout = setTimeout(
      () => waiter.reject(new Error(`DAP session tree outcome timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.catch(() => {});
    return promise;
  }

  async #awaitStopOutcome(
    session: Session,
    outcomePromise: Promise<unknown>,
    timeoutMs: number,
  ): Promise<Outcome> {
    try {
      await outcomePromise;
      const active = this.#getActiveSessionOrNull();
      const resultSession =
        active && this.#getRootSession(active).id === this.#getRootSession(session).id ? active : session;
      if (resultSession.status === 'stopped') {
        await this.#fetchTopFrame(resultSession, Math.min(timeoutMs, this.#settings.stopCaptureTimeoutMs));
      }
      const state =
        resultSession.status === 'stopped'
          ? 'stopped'
          : resultSession.status === 'terminated'
            ? 'terminated'
            : 'running';
      return { outcome: state, snapshot: buildSummary(resultSession) };
    } catch (error) {
      const active = this.#getActiveSessionOrNull();
      const resultSession =
        active && this.#getRootSession(active).id === this.#getRootSession(session).id ? active : session;
      return {
        outcome: 'running',
        snapshot: buildSummary(resultSession),
      };
    }
  }

  /** 流控族线程解析（§4.6.7-2）：显式 ?? 缓存 ?? threads 请求 [0]，无 → E-U7 */
  async #resolveThreadId(session: Session, timeoutMs: number): Promise<number> {
    if (session.stop.threadId !== undefined) {
      return session.stop.threadId;
    }
    if (session.threads.length > 0) {
      return session.threads[0].id;
    }
    const response = await this.#sendRequestWithConfig<{ threads?: Thread[] }>(session, 'threads', undefined);
    session.threads = response?.threads ?? [];
    const threadId = session.threads[0]?.id;
    if (threadId === undefined) {
      throw missingFieldError('threadId', 'No threads reported by the debugger. Run threads first or supply thread_id.');
    }
    return threadId;
  }

  // ── 握手与启动 ────────────────────────────────────────────────────────

  #sendInitialize(client: DapClient, adapter: ResolvedAdapter): Promise<DapCapabilities> {
    return client.sendRequest<DapCapabilities>(
      'initialize',
      { ...CLIENT_INITIALIZE_ARGUMENTS_BASE, adapterID: adapter.name },
      this.#settings.requestTimeoutMs,
    );
  }

  async #completeConfigurationHandshake(session: Session, timeoutMs: number): Promise<void> {
    if (session.configurationDoneSent) return;
    if (!session.needsConfigurationDone) {
      if (session.parentSessionId) {
        await this.#applyRootBreakpointsToSession(session, timeoutMs);
      }
      if (session.status === 'launching' || session.status === 'configuring') {
        session.status = 'running';
      }
      return;
    }
    if (!session.initializedSeen) {
      try {
        await this.#waitForEvent(session, 'initialized', timeoutMs);
      } catch {
        // 适配器可能不发 initialized（如已终止）；launch/attach 响应会暴露真实错误。
        return;
      }
    }
    if (session.parentSessionId) {
      await this.#applyRootBreakpointsToSession(session, timeoutMs);
    }
    await session.client.sendRequest('configurationDone', {}, this.#settings.requestTimeoutMs);
    session.configurationDoneSent = true;
    if (session.status === 'configuring') {
      session.status = 'running';
    }
  }

  /** 以 onEvent 自建事件等待（DapClient 无 waitForEvent；先订后发成立依赖同步派发） */
  #waitForEvent(session: Session, event: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsub = session.client.onEvent(event, (body) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsub();
        resolve(body);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        reject(new Error(`timed out waiting for DAP event '${event}' after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  async #startChildSession(
    parent: Session,
    request: 'launch' | 'attach',
    configuration: Record<string, unknown>,
  ): Promise<void> {
    const port = parent.client.port ?? 0;
    const cwd = path.resolve(parent.cwd, typeof configuration.cwd === 'string' ? configuration.cwd : '.');
    const client = await this.#clientFactory({
      adapter: parent.adapter,
      cwd,
      connection: { kind: 'tcp', host: '127.0.0.1', port },
      requestTimeoutMs: this.#settings.requestTimeoutMs,
    });
    const child = this.#registerSession(
      client,
      parent.adapter,
      cwd,
      typeof configuration.program === 'string' ? configuration.program : undefined,
      parent.id,
    );
    try {
      child.capabilities = await this.#sendInitialize(client, parent.adapter);
      child.needsConfigurationDone = child.capabilities.supportsConfigurationDoneRequest === true;
      const startFailure: StartRequestFailure = { rejected: false };
      const startPromise = trackDapStartRequest(
        client.sendRequest(request, { ...configuration, cwd }, this.#settings.requestTimeoutMs),
        startFailure,
      );
      startPromise.catch(() => {});
      try {
        await this.#completeConfigurationHandshake(child, DEFAULT_TIMEOUT_MS);
      } catch (error) {
        await throwPreferredDapStartError(request, startFailure, error);
      }
      await startPromise;
    } catch (error) {
      await this.#disposeSession(child);
      // 子会话启动路径的 client 层 E-A3（无前缀）须以会话 id 重包装（Ruling 1）
      throw this.#rewrapAdapterError(child, error);
    }
  }

  // ── 注册与事件 ────────────────────────────────────────────────────────

  #registerSession(
    client: DapClient,
    adapter: ResolvedAdapter,
    cwd: string,
    program?: string,
    parentSessionId?: string,
  ): Session {
    const id = parentSessionId ? this.#deriveChildId(parentSessionId) : `${adapter.name}-${++this.#rootSeq}`;
    const session: Session = {
      id,
      adapter,
      cwd,
      program,
      client,
      status: 'launching',
      launchedAt: Date.now(),
      lastUsedAt: Date.now(),
      breakpoints: new Map(),
      functionBreakpoints: [],
      instructionBreakpoints: [],
      dataBreakpoints: [],
      breakpointMutationQueue: Promise.resolve(),
      outputChunks: [],
      outputBytes: 0,
      outputBufferedBytes: 0,
      outputTruncated: false,
      stop: {},
      threads: [],
      lastStackFrames: [],
      initializedSeen: false,
      needsConfigurationDone: false,
      configurationDoneSent: false,
      parentSessionId,
      childSessionIds: new Set(),
    };

    client.onReverseRequest('runInTerminal', async (rawArgs) => {
      if (!this.#settings.allowRunInTerminal) {
        throw new Error('runInTerminal is disabled by settings.allowRunInTerminal');
      }
      const args = (rawArgs ?? {}) as DapRunInTerminalArguments;
      if (!Array.isArray(args.args) || args.args.length === 0) {
        throw new Error('runInTerminal request did not include a command');
      }
      const proc = spawnProcess({
        command: args.args[0],
        args: args.args.slice(1),
        cwd: path.resolve(session.cwd, args.cwd ?? '.'),
        env: filterNullEnv(args.env),
        logger: this.#logger,
      });
      void this.#drainTerminalStdout(proc, session);
      return { processId: proc.pid } satisfies DapRunInTerminalResponse;
    });
    client.onReverseRequest('startDebugging', async (rawArgs) => {
      const startArgs = (rawArgs ?? {}) as Partial<DapStartDebuggingArguments>;
      const request = startArgs.request === 'attach' ? 'attach' : 'launch';
      const configuration =
        startArgs.configuration && typeof startArgs.configuration === 'object' ? startArgs.configuration : {};
      this.#logger.debug('Adapter requested child debug session', {
        adapter: session.adapter.name,
        sessionId: session.id,
        request,
      });
      await this.#startChildSession(session, request, configuration);
      return {};
    });
    client.onEvent('output', (body) => {
      truncateOutput(session, (body as DapOutputEventBody | undefined)?.output ?? '', this.#settings.maxOutputBytes);
    });
    client.onEvent('initialized', () => {
      session.initializedSeen = true;
      if (!session.configurationDoneSent && session.status === 'launching') {
        session.status = 'configuring';
      }
    });
    client.onEvent('stopped', (body) => {
      this.#handleStoppedEvent(session, body as DapStoppedEventBody);
      this.#activeSessionId = session.id;
      this.#resolveTreeOutcome(session);
    });
    client.onEvent('continued', (body) => {
      const continued = body as { threadId?: number } | undefined;
      session.status = 'running';
      session.stop = { threadId: continued?.threadId };
      session.lastStackFrames = [];
    });
    client.onEvent('exited', (body) => {
      session.exitCode = (body as { exitCode?: number } | undefined)?.exitCode;
      session.status = 'terminated';
      session.terminatedAt = Date.now();
      this.#reactivateAfterTermination(session);
      this.#resolveTreeOutcome(session);
    });
    client.onEvent('terminated', () => {
      session.status = 'terminated';
      session.terminatedAt = Date.now();
      this.#reactivateAfterTermination(session);
      this.#resolveTreeOutcome(session);
    });

    this.#sessions.set(session.id, session);
    if (parentSessionId) {
      this.#sessions.get(parentSessionId)?.childSessionIds.add(session.id);
    }
    // 焦点跟随 stop 而非注册：懒挂载子会话不得抢占已停止的兄弟会话（§4.6.4-2）
    if (!this.#hasLiveStoppedActiveSession()) {
      this.#activeSessionId = session.id;
    }
    const heartbeat = setInterval(() => {
      if (!client.isAlive()) {
        session.status = 'terminated';
        session.terminatedAt = Date.now();
        this.#reactivateAfterTermination(session);
        this.#resolveTreeOutcome(session);
      }
    }, this.#settings.heartbeatIntervalMs);
    heartbeat.unref?.();
    session.heartbeatTimer = heartbeat;
    return session;
  }

  /** runInTerminal debuggee 的 stdout 接入输出环（Bun ptree drain 语义移植；防反压） */
  #drainTerminalStdout(proc: SpawnedProcess, session: Session): void {
    const stdout = proc.child.stdout;
    if (!stdout) return;
    stdout.on('data', (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      truncateOutput(session, text, this.#settings.maxOutputBytes);
    });
  }

  #handleStoppedEvent(session: Session, stopped: DapStoppedEventBody): void {
    session.status = 'stopped';
    session.stop = {
      threadId: stopped.threadId,
      reason: stopped.reason,
      description: stopped.description,
      text: stopped.text,
    };
    session.lastStackFrames = [];
  }

  #applyTopFrame(session: Session, frame: StackFrame | undefined): void {
    if (!frame) return;
    session.stop.frameId = frame.id;
    session.stop.frameName = frame.name;
    session.stop.instructionPointerReference = frame.instructionPointerReference;
    session.stop.source = frame.source;
    session.stop.line = frame.line;
    session.stop.column = frame.column;
  }

  /** 停止后 topFrame 回填（levels=1）；失败仅记 debug，不打断主流程 */
  async #fetchTopFrame(session: Session, timeoutMs: number): Promise<void> {
    if (session.stop.threadId === undefined) return;
    try {
      const response = await session.client.sendRequest<{ stackFrames?: StackFrame[] }>(
        'stackTrace',
        { threadId: session.stop.threadId, levels: 1 },
        timeoutMs,
      );
      session.lastStackFrames = response?.stackFrames ?? [];
      this.#applyTopFrame(session, session.lastStackFrames[0]);
    } catch (error) {
      this.#logger.debug('Failed to capture stopped frame', {
        sessionId: session.id,
        error: toErrorMessage(error),
      });
    }
  }

  // ── 焦点与目标解析（§4.6.4）──────────────────────────────────────────

  #resolveTarget(opts?: CallOptions): Session {
    let session: Session | null;
    if (opts?.sessionId !== undefined) {
      const found = this.#sessions.get(opts.sessionId) ?? null;
      if (!found) throw unknownSessionIdError(opts.sessionId);
      session = found;
    } else {
      session = this.#getActiveSessionOrNull();
      if (!session) throw noActiveSessionError();
    }
    this.#touchSessionAndAncestors(session);
    return session;
  }

  #resolveTargetForTerminate(opts?: CallOptions): Session | null {
    if (opts?.sessionId !== undefined) {
      const found = this.#sessions.get(opts.sessionId);
      if (!found) throw unknownSessionIdError(opts.sessionId);
      return found;
    }
    return this.#getActiveSessionOrNull();
  }

  #getActiveSessionOrNull(): Session | null {
    if (this.#activeSessionId === null) return null;
    const session = this.#sessions.get(this.#activeSessionId) ?? null;
    if (!session) this.#activeSessionId = null;
    return session;
  }

  /** 当前焦点是否"存活且 status==='stopped'"（防懒挂载子会话抢占，§4.6.4-2） */
  #hasLiveStoppedActiveSession(): boolean {
    const active = this.#getActiveSessionOrNull();
    return active !== null && active.status === 'stopped' && active.client.isAlive();
  }

  #getRootSession(session: Session): Session {
    let root = session;
    while (root.parentSessionId) {
      const parent = this.#sessions.get(root.parentSessionId);
      if (!parent) break;
      root = parent;
    }
    return root;
  }

  #getTreeSessions(session: Session): Session[] {
    const sessions: Session[] = [];
    const pending = [this.#getRootSession(session)];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      sessions.push(current);
      for (const childId of current.childSessionIds) {
        const child = this.#sessions.get(childId);
        if (child) pending.push(child);
      }
    }
    return sessions;
  }

  /** 存活（非 terminated、client 存活）树节点；树塌缩时回落会话自身（threads 聚合用） */
  #liveTreeSessions(session: Session): Session[] {
    const live = this.#getTreeSessions(session).filter(
      (candidate) => candidate.status !== 'terminated' && candidate.client.isAlive(),
    );
    return live.length > 0 ? live : [session];
  }

  #touchSessionAndAncestors(session: Session): void {
    const now = Date.now();
    let current: Session | undefined = session;
    while (current) {
      current.lastUsedAt = now;
      current = current.parentSessionId ? this.#sessions.get(current.parentSessionId) : undefined;
    }
  }

  /** 终止回退（§4.6.4-4）：焦点节点消亡 → 同树首个 stopped，否则任一存活子孙，否则置 null */
  #reactivateAfterTermination(session: Session): void {
    if (this.#activeSessionId !== session.id) return;
    const live = this.#getTreeSessions(session).filter(
      (candidate) => candidate.status !== 'terminated' && candidate.client.isAlive(),
    );
    if (live.length === 0) {
      this.#activeSessionId = null;
      return;
    }
    const replacement =
      live.find((candidate) => candidate.status === 'stopped') ??
      live.find((candidate) => candidate.parentSessionId !== undefined) ??
      live[0];
    this.#activeSessionId = replacement.id;
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────

  /** 根槽位获取（I-1）：占位期间或已存在根 → E-U6 精确串；通过后立即置占位，调用方须以 finally 释放 */
  #ensureLaunchSlot(): void {
    if (this.#startingRoot) throw busyRootSessionError();
    for (const session of [...this.#sessions.values()]) {
      // 死根（未终止但 adapter 已灭）立即清；terminated 会话保留宽限期，仅由
      // #cleanupIdleSessions 到期回收（不在此立删，保 output/exitCode 读取窗口）
      if (session.status !== 'terminated' && !session.client.isAlive()) {
        this.#disposeSession(session);
      }
    }
    // 宽限期内的 terminated 根不阻塞新会话（§5.1 单根约束只针对活跃根）
    const root = [...this.#sessions.values()].find(
      (session) => !session.parentSessionId && session.status !== 'terminated',
    );
    if (root) throw busyRootSessionError();
    this.#startingRoot = true;
  }

  #startCleanupTimer(): void {
    if (this.#cleanupTimer) return;
    this.#cleanupTimer = setInterval(() => {
      try {
        this.#cleanupIdleSessions();
      } catch (error) {
        this.#logger.error('DAP idle session cleanup failed', { error: toErrorMessage(error) });
      }
    }, this.#settings.cleanupIntervalMs);
    this.#cleanupTimer.unref?.();
  }

  #cleanupIdleSessions(): void {
    if (this.#sessions.size === 0) return;
    const now = Date.now();
    for (const session of [...this.#sessions.values()]) {
      // terminated 会话进入宽限期（terminatedRetentionMs，默认 5min），到期才回收；
      // 其余会话维持 idle/死亡即时回收语义
      const expired =
        session.status === 'terminated'
          ? now - (session.terminatedAt ?? session.lastUsedAt) > this.#settings.terminatedRetentionMs
          : now - session.lastUsedAt > this.#settings.idleTimeoutMs || !session.client.isAlive();
      if (expired) {
        this.#disposeSession(session);
      }
    }
  }

  async #terminateSessionTree(session: Session): Promise<void> {
    session.status = 'terminated';
    session.terminatedAt = Date.now();
    try {
      for (const childId of [...session.childSessionIds]) {
        const child = this.#sessions.get(childId);
        if (child) await this.#terminateSessionTree(child);
      }
      if (session.capabilities?.supportsTerminateRequest) {
        await session.client.sendRequest('terminate', undefined, this.#settings.requestTimeoutMs).catch(() => undefined);
      }
      await session.client
        .sendRequest('disconnect', { terminateDebuggee: true }, this.#settings.requestTimeoutMs)
        .catch(() => undefined);
    } catch {
      // Disposal remains mandatory when best-effort DAP shutdown fails.
    } finally {
      // 主动 terminate 同样进入宽限期：保留 terminated 会话至 terminatedRetentionMs
      // 到期（output/exitCode 读取窗口稳定），由 #cleanupIdleSessions 定时回收。
      // 焦点回退：若 adapter 未回 terminated/exited 事件，此处显式结算。
      this.#reactivateAfterTermination(session);
    }
  }

  #disposeSession(session: Session): void {
    if (!this.#sessions.has(session.id)) return;
    for (const childId of [...session.childSessionIds]) {
      const child = this.#sessions.get(childId);
      if (child) this.#disposeSession(child);
    }
    this.#sessions.delete(session.id);
    if (session.parentSessionId) {
      this.#sessions.get(session.parentSessionId)?.childSessionIds.delete(session.id);
    }
    if (this.#activeSessionId === session.id) {
      const parent = session.parentSessionId ? this.#sessions.get(session.parentSessionId) : undefined;
      this.#activeSessionId = parent?.id ?? this.#sessions.values().next().value?.id ?? null;
    }
    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
    void session.client.dispose().catch(() => {});
  }

  // ── 事件结算 ──────────────────────────────────────────────────────────

  #resolveTreeOutcome(session: Session): void {
    const rootId = this.#getRootSession(session).id;
    for (const waiter of [...this.#treeOutcomeWaiters]) {
      if (waiter.rootSessionId === rootId) {
        waiter.resolve(undefined);
      }
    }
  }

  // ── id 生成（api-contract §4.7）───────────────────────────────────────

  /** 树内 memberSeq 拍平：第 m 个子节点 id = <root>.<m>（无论层级，不嵌套） */
  #deriveChildId(parentSessionId: string): string {
    const root = this.#getRootSessionById(parentSessionId);
    const seq = (this.#memberSeqByRoot.get(root.id) ?? 0) + 1;
    this.#memberSeqByRoot.set(root.id, seq);
    return `${root.id}.${seq}`;
  }

  #getRootSessionById(sessionId: string): Session {
    let current = this.#sessions.get(sessionId);
    if (!current) {
      // 防御：父会话已不存在（不应发生），以输入 id 为根退避
      throw new Error(`parent session '${sessionId}' not found`);
    }
    while (current.parentSessionId) {
      const parent = this.#sessions.get(current.parentSessionId);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  // ── 断点记录映射（§3.5；verified 经适配器回传）────────────────────────

  #mapSourceBreakpoints(
    input: SourceBreakpointRecord[],
    responseBreakpoints: DapBreakpoint[] | undefined,
  ): SourceBreakpointRecord[] {
    return input.map((entry, index) => {
      const bp = responseBreakpoints?.[index];
      return {
        line: typeof bp?.line === 'number' ? bp.line : entry.line,
        ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
        ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
        ...(bp?.id !== undefined ? { id: bp.id } : {}),
        verified: bp?.verified ?? false,
        ...(bp?.message !== undefined ? { message: bp.message } : {}),
      };
    });
  }

  #mapFunctionBreakpoints(
    input: FunctionBreakpointRecord[],
    responseBreakpoints: DapBreakpoint[] | undefined,
  ): FunctionBreakpointRecord[] {
    return input.map((entry, index) => {
      const bp = responseBreakpoints?.[index];
      return {
        name: entry.name,
        ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
        ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
        ...(bp?.id !== undefined ? { id: bp.id } : {}),
        verified: bp?.verified ?? false,
        ...(bp?.message !== undefined ? { message: bp.message } : {}),
      };
    });
  }

  #mapInstructionBreakpoints(
    input: InstructionBreakpointRecord[],
    responseBreakpoints: DapBreakpoint[] | undefined,
  ): InstructionBreakpointRecord[] {
    return input.map((entry, index) => {
      const bp = responseBreakpoints?.[index];
      return {
        instructionReference:
          typeof bp?.instructionReference === 'string' ? bp.instructionReference : entry.instructionReference,
        ...(typeof bp?.offset === 'number'
          ? { offset: bp.offset }
          : entry.offset !== undefined
            ? { offset: entry.offset }
            : {}),
        ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
        ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
        ...(bp?.id !== undefined ? { id: bp.id } : {}),
        verified: bp?.verified ?? false,
        ...(bp?.message !== undefined ? { message: bp.message } : {}),
      };
    });
  }

  #mapDataBreakpoints(
    input: DataBreakpointRecord[],
    responseBreakpoints: DapBreakpoint[] | undefined,
  ): DataBreakpointRecord[] {
    return input.map((entry, index) => {
      const bp = responseBreakpoints?.[index];
      return {
        dataId: entry.dataId,
        ...(entry.accessType !== undefined ? { accessType: entry.accessType } : {}),
        ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
        ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
        ...(bp?.id !== undefined ? { id: bp.id } : {}),
        verified: bp?.verified ?? false,
        ...(bp?.message !== undefined ? { message: bp.message } : {}),
      };
    });
  }

  // ── 序列化辅助 ────────────────────────────────────────────────────────

  #instructionBreakpointsToDap(input: InstructionBreakpointRecord[]): Record<string, unknown>[] {
    return input.map((entry) => ({
      instructionReference: entry.instructionReference,
      ...(entry.offset !== undefined ? { offset: entry.offset } : {}),
      ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
      ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
    }));
  }

  #dataBreakpointsToDap(input: DataBreakpointRecord[]): Record<string, unknown>[] {
    return input.map((entry) => ({
      dataId: entry.dataId,
      ...(entry.accessType !== undefined ? { accessType: entry.accessType } : {}),
      ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
      ...(entry.hitCondition !== undefined ? { hitCondition: entry.hitCondition } : {}),
    }));
  }

  // ── 能力门控与错误 ────────────────────────────────────────────────────

  #assertCapability(session: Session, gate: keyof typeof CAPABILITY_GATES): void {
    const { field, description } = CAPABILITY_GATES[gate];
    const caps = session.capabilities ?? {};
    if (caps[field] !== true) {
      throw capabilityNotSupportedError(session.adapter.name, field, description);
    }
  }

  /**
   * 会话上下文请求封装：前置自动补发 configurationDone；client 层 E-A3（adapter）
   * 以 `adapterExitedError(sessionId, …)` 重包装补会话 id 前缀（Ruling 1）；E-P1/E-P2
   * 直透（Ruling 2），E-U3/E-A1/E-A2 由上层抛出不改。
   */
  async #sendRequestWithConfig<TBody>(session: Session, command: string, args: Record<string, unknown> | undefined): Promise<TBody> {
    await this.#ensureConfigurationDone(session);
    try {
      const body = await session.client.sendRequest<TBody>(command, args, this.#settings.requestTimeoutMs);
      this.#touchSessionAndAncestors(session);
      return body;
    } catch (error) {
      throw this.#rewrapAdapterError(session, error);
    }
  }

  async #ensureConfigurationDone(session: Session): Promise<void> {
    if (!session.needsConfigurationDone || session.configurationDoneSent) {
      return;
    }
    await session.client.sendRequest('configurationDone', {}, this.#settings.requestTimeoutMs);
    session.configurationDoneSent = true;
    if (session.status === 'configuring') {
      session.status = 'running';
    }
  }

  #rewrapAdapterError(session: Session, error: unknown): unknown {
    if (error instanceof Error && (error as { code?: string }).code === 'adapter') {
      const details = (error as { details?: Record<string, unknown> }).details;
      const exitCode =
        typeof details?.exitCode === 'number'
          ? details.exitCode
          : typeof (error as { exitCode?: unknown }).exitCode === 'number'
            ? ((error as unknown as { exitCode: number }).exitCode)
            : -1;
      const stderrExcerpt = typeof details?.stderrExcerpt === 'string' ? details.stderrExcerpt : undefined;
      throw adapterExitedError(session.id, exitCode, stderrExcerpt);
    }
    throw error;
  }
}

/** DAP runInTerminal env 的 null 值 = 取消该变量（§4.6.6 语义；非交互注入由 spawnProcess 完成） */
function filterNullEnv(env: Record<string, string | null> | undefined): Record<string, string | undefined> | undefined {
  if (env === undefined) return undefined;
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== null) out[key] = value;
  }
  return out;
}
