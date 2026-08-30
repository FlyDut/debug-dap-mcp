/**
 * DAP 客户端（DESIGN.md §8.1/§8.2，api-contract §4.2）。
 *
 * 移植 oh-my-pi `dap/client.ts`（1043 行）去宿主化：
 *   - Bun API → node:net / node:child_process（字节流 transport 按 Task 9 接口注入）；
 *   - ptree → core/process.ts（transport.proc 承载，`proc.exited` 即进程退出信号）；
 *   - logger → core/log.ts（debug 级输出帧收发摘要）；
 *   - 无 AbortSignal：MCP stdio 下取消语义 = stdin EOF → `dispose()`（DESIGN.md §5.5）。
 *
 * 错误折叠（Controller Ruling）：client 侧单点折叠为 E-P1/E-P2/E-A3，Task 12 不得重复
 * 包装。E-A3 的 message 不含 session id 前缀（client 不知会话 id），id 上下文由
 * Task 12 决定是否补充。
 */

import * as net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { MessageFramer, encodeFrame } from './framing.js';
import {
  adapterConnectionError,
  DebugToolError,
  requestFailedError,
  requestTimedOutError,
} from './errors.js';
import type { DapEventMessage, DapRequestMessage, DapResponseMessage } from './protocol/types.js';
import { makeByteTransport, openTransport, type ByteTransport } from './transports/index.js';
import type { ResolvedAdapter } from './adapter-registry.js';
import type { SpawnedProcess } from './process.js';
import type { Logger } from './log.js';

export type { ResolvedAdapter } from './adapter-registry.js';

export type DapEventHandler = (body: unknown) => void;
export type DapReverseRequestHandler = (args: unknown) => unknown;
export type Unsubscribe = () => void;

/** 会话树复连形态：startDebugging 派生的子会话连向父适配器内嵌 DAP server */
export type ClientConnection =
  | { kind: 'spawn' }
  | { kind: 'tcp'; host: string; port: number };

export interface DapClient {
  /** tcp transport（或 tcp 复连）下会话端点端口，供子会话复用；其他情况 undefined */
  readonly port?: number;
  /**
   * 发送 DAP 请求并以 success response 的 body 结算；
   * error response → DebugToolError("protocol")（E-P1）；
   * requestTimeoutMs 到期未响应 → DebugToolError("protocol")（E-P2）；
   * 连接失效/进程退出 → DebugToolError("adapter")（E-A3）。
   * @param args 序列化为 request.arguments；undefined 时不写该字段
   */
  sendRequest<T = unknown>(command: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** 订阅事件（stopped/terminated/output/exited/initialized/continued/…）；处理器同步分发，保证"先订后发"成立 */
  onEvent(event: string, handler: DapEventHandler): Unsubscribe;
  /** 注册反向请求处理器（runInTerminal/startDebugging）；同命令后注册覆盖前者 */
  onReverseRequest(command: string, handler: DapReverseRequestHandler): Unsubscribe;
  isAlive(): boolean;
  /** 关闭底层传输并拒绝全部 pending（幂等） */
  dispose(): Promise<void>;
}

export type ClientFactory = (options: {
  adapter: ResolvedAdapter;
  cwd: string;
  connection: ClientConnection;
  requestTimeoutMs: number;
}) => Promise<DapClient>;

interface PendingEntry {
  command: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** 生产实现（§4.2 :322）；FakeClient 与内存桩测试直接 new 本类以注入内存 transport */
export class NodeDapClient implements DapClient {
  readonly port?: number;
  readonly #transport: ByteTransport;
  readonly #requestTimeoutMs: number;
  readonly #logger: Logger;
  #requestSeq = 0;
  #pending = new Map<number, PendingEntry>();
  #disposed = false;
  #connectionLost = false;
  #exitCode: number | null = null;
  #eventHandlers = new Map<string, Set<DapEventHandler>>();
  #reverseHandlers = new Map<string, DapReverseRequestHandler>();

  constructor(transport: ByteTransport, requestTimeoutMs: number, logger?: Logger) {
    this.#transport = transport;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#logger = logger ?? { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    this.port = transport.port;
    void transport.proc.exited.then(
      (code) => this.#onProcessExit(code),
      () => this.#onProcessExit(null),
    );
    void this.#startReader();
  }

  sendRequest<T = unknown>(command: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (this.#disposed || this.#connectionLost) {
      return Promise.reject(this.#adapterGoneError());
    }
    const requestSeq = ++this.#requestSeq;
    const request: DapRequestMessage = {
      seq: requestSeq,
      type: 'request',
      command,
      ...(args !== undefined ? { arguments: args } : {}),
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      const effectiveTimeout =
        timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : this.#requestTimeoutMs;
      const timer = setTimeout(() => {
        if (!this.#pending.has(requestSeq)) return;
        this.#pending.delete(requestSeq);
        reject(requestTimedOutError(command, effectiveTimeout));
      }, effectiveTimeout);
      this.#pending.set(requestSeq, { command, resolve, reject, timer });
    });
    this.#logger.debug(`DAP request: ${command}`, { seq: requestSeq, ...(args !== undefined ? { args } : {}) });
    try {
      this.#write(request);
    } catch {
      // transport.write 同步抛错（socket 已断/已销毁）→ 连接失效折叠 E-A3，全拒
      this.#failConnection();
    }
    return promise as Promise<T>;
  }

  onEvent(event: string, handler: DapEventHandler): Unsubscribe {
    let handlers = this.#eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.#eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
    };
  }

  onReverseRequest(command: string, handler: DapReverseRequestHandler): Unsubscribe {
    const previous = this.#reverseHandlers.get(command);
    this.#reverseHandlers.set(command, handler); // 后注册覆盖前者
    return () => {
      if (previous !== undefined) this.#reverseHandlers.set(command, previous);
      else this.#reverseHandlers.delete(command);
    };
  }

  isAlive(): boolean {
    return !this.#disposed && !this.#connectionLost;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rejectAllPending(this.#adapterGoneError());
    this.#transport.close();
    await this.#transport.closed.catch(() => {});
  }

  // ── 内部 ─────────────────────────────────────────────────────────

  #write(message: DapRequestMessage | DapResponseMessage): void {
    const label = message.type === 'response' ? `${message.command} (req ${message.request_seq})` : message.command;
    this.#logger.debug(`DAP out ${message.type}: ${label}`);
    this.#transport.write(encodeFrame(message));
  }

  async #startReader(): Promise<void> {
    const reader = this.#transport.readable.getReader();
    const framer = new MessageFramer(Buffer.alloc(0));
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        framer.push(Buffer.from(value));
        for (const messageText of framer.drain((headerText) => {
          this.#logger.warn('DAP framing resync: header block without Content-Length', {
            header: headerText.slice(0, 200),
          });
        })) {
          try {
            const message = JSON.parse(messageText) as
              | DapResponseMessage
              | DapEventMessage
              | DapRequestMessage;
            if (message.type === 'response') {
              this.#handleResponse(message);
            } else if (message.type === 'event') {
              this.#dispatchEvent(message);
            } else {
              this.#handleAdapterRequest(message);
            }
          } catch (error) {
            // 畸形消息不杀 reader：后续消息仍按帧解析（移植源同构）
            this.#logger.warn('DAP message handling failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } catch (error) {
      this.#logger.warn('DAP reader closed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      reader.releaseLock();
      // 读流结束/错误 = 连接失效 → 折叠 E-A3
      this.#failConnection();
    }
  }

  #handleResponse(message: DapResponseMessage): void {
    const pending = this.#pending.get(message.request_seq);
    if (!pending) return;
    this.#pending.delete(message.request_seq);
    clearTimeout(pending.timer);
    if (message.success) {
      pending.resolve(message.body);
      return;
    }
    // DAP error response 的错误文本在顶层 message 字段（body 常为 undefined）；D-2：
    // body 缺失时取 message.message，避免 JSON.stringify(undefined) → "undefined" 丢文本
    pending.reject(requestFailedError(pending.command, message.request_seq, message.body ?? message.message));
  }

  /** 事件处理器同步分发：保证「先订后发」成立（§4.2 :303） */
  #dispatchEvent(message: DapEventMessage): void {
    this.#logger.debug(`DAP event: ${message.event}`, { body: message.body });
    const handlers = this.#eventHandlers.get(message.event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(message.body);
      } catch (error) {
        this.#logger.warn('DAP event handler failed', {
          event: message.event,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * 反向请求：同步/异步 handler 统一以 Promise 链结算——返回值即响应 body（undefined 不写）；
   * 同步 throw 或 async reject 一律回失败响应（success:false + message）。
   * 先经 `Promise.resolve().then` 触发 handler：同步 throw 也被 .then 捕获（裸 `handler(args)`
   * 的同步 throw 在参数求值时即逃逸）。同命令后注册覆盖前者（§4.2）。
   */
  #handleAdapterRequest(message: DapRequestMessage): void {
    const handler = this.#reverseHandlers.get(message.command);
    if (handler) {
      const writeSuccess = (body: unknown): void => {
        this.#write({
          seq: ++this.#requestSeq,
          type: 'response',
          request_seq: message.seq,
          success: true,
          command: message.command,
          ...(body !== undefined ? { body } : {}),
        });
      };
      const writeFailure = (error: unknown): void => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.#write({
          seq: ++this.#requestSeq,
          type: 'response',
          request_seq: message.seq,
          success: false,
          command: message.command,
          message: errorMessage,
          body: { error: { id: 1, format: errorMessage } },
        });
      };
      Promise.resolve()
        .then(() => handler(message.arguments))
        .then(writeSuccess, writeFailure);
      return;
    }
    const errorMessage = `Unsupported DAP request: ${message.command}`;
    this.#write({
      seq: ++this.#requestSeq,
      type: 'response',
      request_seq: message.seq,
      success: false,
      command: message.command,
      message: errorMessage,
      body: { error: { id: 1, format: errorMessage } },
    });
  }

  #onProcessExit(code: number | null): void {
    this.#exitCode = code;
    this.#logger.warn('DAP adapter process exited', { code });
    this.#failConnection();
  }

  /**
   * 连接失效单点折叠：进程退出、读流结束、transport.write 抛错均落到这里，全部
   * pending 以同一 E-A3（adapter 错误）拒绝。message 不含 session id 前缀（client 不知
   * 会话 id；Ruling，id 上下文由 Task 12 决定是否补充）。
   */
  #failConnection(): void {
    if (this.#disposed || this.#connectionLost) return;
    this.#connectionLost = true;
    this.#rejectAllPending(this.#adapterGoneError());
  }

  #adapterGoneError(): DebugToolError {
    const exitCode = this.#exitCode;
    const stderrExcerpt = this.#transport.stderrExcerpt();
    return new DebugToolError(
      'adapter',
      `adapter exited unexpectedly (exit code ${exitCode ?? -1})`,
      {
        ...(exitCode !== null ? { exitCode } : {}),
        ...(stderrExcerpt.length > 0 ? { stderrExcerpt } : {}),
      },
    );
  }

  #rejectAllPending(error: Error): void {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }
}

export interface CreateNodeDapClientOptions {
  adapter: ResolvedAdapter;
  cwd: string;
  connection: ClientConnection;
  requestTimeoutMs: number;
  logger?: Logger;
  /** socket/tcp transport 就绪等待时长（ms）；可注入缩短以便测试 */
  socketReadyTimeoutMs?: number;
}

/**
 * 生产装配（api-contract §4.2 :322）：connection.kind 分派——
 * - spawn：按 adapter.transport 三态 openTransport（新拉起适配器进程）；
 * - tcp：复连既有 DAP server（startDebugging 派生子会话），不 spawn。
 */
export async function createNodeDapClient(options: CreateNodeDapClientOptions): Promise<DapClient> {
  const { adapter, cwd, connection, requestTimeoutMs, logger, socketReadyTimeoutMs } = options;
  if (connection.kind === 'tcp') {
    const transport = await connectTcpTransport(connection.host, connection.port, logger);
    return new NodeDapClient(transport, requestTimeoutMs, logger);
  }
  const transport = await openTransport({
    transport: adapter.transport,
    command: adapter.command,
    args: adapter.args,
    cwd,
    // 适配器声明的环境叠加层（DESIGN §4.2 adapter.env）：叠加在 MCP 进程环境之上，
    // 显式键优先（openTransport 的 env 是替换语义，必须先铺底再覆盖）。
    env: { ...process.env, ...(adapter.env ?? {}) },
    logger,
    socketReadyTimeoutMs,
  });
  return new NodeDapClient(transport, requestTimeoutMs, logger);
}

/**
 * 连接既有 TCP DAP server 并装配 ByteTransport。虚拟 proc 的 `exited` 与 socket 关闭
 * 挂钩——对端关闭连接即视为连接失效（E-A3 素材）。连接期失败（ECONNREFUSED 等）
 * → E-A2（复连既有 server 的连接语义，与 transports 的 E-A2 一致）。
 */
async function connectTcpTransport(
  host: string,
  port: number,
  logger?: Logger,
): Promise<ByteTransport> {
  const socket = net.createConnection({ host, port });
  const endpoint = `${host}:${port}`;
  const exited = new Promise<number | null>((resolve) => {
    socket.once('close', () => resolve(null));
  });
  await new Promise<void>((resolve, reject) => {
    let connected = false;
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (connected) return; // 连接后的错误由 wrapReadable 处理
      reject(
        adapterConnectionError({
          transport: 'tcp',
          endpoint,
          reason: err.code ?? undefined,
        }),
      );
    });
    socket.once('connect', () => {
      connected = true;
      resolve();
    });
  });
  const proc: SpawnedProcess = {
    child: {} as ChildProcess,
    pid: 0,
    exited,
    killTree: async () => {
      socket.destroy();
    },
  };
  return makeByteTransport({ proc, logger, socket, port });
}
