/**
 * 传输层聚合（DESIGN.md §8.2/§8.3，移植 oh-my-pi dap/client.ts 的 transport 分支）。
 *
 * 本层是**字节流层**：统一接口（读流/写流/关闭/就绪等待/进程管理），Content-Length 帧
 * 归 framing.ts/client 层消费，不在此层引入。api-contract §4.3 注：transport 接口不在
 * 契约展开（:322 明示），故本接口按两处对齐自定：(a) 移植源 client 的消费形态
 * （ReadableStream + write sink + socket.end + proc.exited）；(b) Task 10 client 以工厂
 * 注入三态（`stdio | socket | tcp`，对应 ResolvedAdapter.transport，api-contract:345）。
 *
 * 三态：
 * - stdio：子进程 stdin/stdout 收发，stderr 转发 log（src/core/transports/stdio.ts）；
 * - socket：unix domain socket——生成 socketPath、等待适配器监听、连接；非 Linux
 *   平台回退为本地 TCP + `--client-addr`（移植源即有，src/core/transports/socket.ts）；
 * - tcp：预占 loopback 空闲端口（供 `${port}` 模板）、等待监听、连接
 *   （src/core/transports/tcp.ts）。
 *
 * 就绪等待/连接失败一律抛 E-A2 工厂错误（src/core/errors.ts，api-contract §3.7）。
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import { PassThrough } from 'node:stream';
import type { Logger } from '../log.js';
import { startOrphanWatcher, type SpawnedProcess } from '../process.js';

/** socket/tcp 就绪等待默认时长（ms；对应 Settings.socketReadyTimeoutMs 缺省 10000） */
export const SOCKET_READY_TIMEOUT_MS = 10_000;

/** transport 三态（对应 ResolvedAdapter.transport，api-contract §4.3） */
export type TransportKind = 'stdio' | 'socket' | 'tcp';

/**
 * 字节流传输层统一接口。client 以 `readable.getReader()` 循环消费原始字节，
 * 以 `write` 写帧化字节，以 `close` 收口；`closed` 在读流结束/错误或进程退出时
 * settle，client 借此快速失败全部 pending（E-A3 素材来源之一）。
 */
export interface ByteTransport {
  /** 读流：transport 层原始字节（未帧化），供 client 的 framing 消费 */
  readonly readable: ReadableStream<Uint8Array>;
  /** 写入口：string 按 utf-8 编码 */
  write(data: Uint8Array | string): void;
  /** 幂等关闭底层（socket.end + 进程树 kill；stdio 仅 kill） */
  close(): void;
  /** 底层失效结算（读流结束/错误、进程退出）；未失效前保持 pending */
  readonly closed: Promise<void>;
  /** 适配器进程（三态均派生）；供 client 关联退出处理 */
  readonly proc: SpawnedProcess;
  /** tcp transport（及 socket 的 macOS 回退）下预占/监听端口；其他 undefined */
  readonly port?: number;
  /** socket transport（unix）生成的 socketPath；其他 undefined */
  readonly socketPath?: string;
  /** 最近 stderr 摘录（供 E-A3 构造）；移植源 proc.peekStderr 对齐 */
  stderrExcerpt(): string;
}

export interface OpenTransportBaseOptions {
  /** 解析后的最终可执行文件 */
  command: string;
  /** 模板展开后的参数；socket/tcp 的 `${socketPath}`/`${port}` 占位符由本层替换 */
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /** 就绪等待时长（ms）；可注入缩短以便测试；缺省 SOCKET_READY_TIMEOUT_MS */
  socketReadyTimeoutMs?: number;
}

export type OpenTransportOptions = OpenTransportBaseOptions & { transport: TransportKind };

/**
 * 按 transport 三态分派到对应工厂（Task 10 client 以工厂注入的入口）。
 * 各工厂位于各自文件（stdio/socket/tcp），此处延迟 import 以避免与工厂的
 * helper 依赖（makeByteTransport 等）构成循环。
 */
export async function openTransport(opts: OpenTransportOptions): Promise<ByteTransport> {
  switch (opts.transport) {
    case 'stdio':
      return (await import('./stdio.js')).openStdioTransport(opts);
    case 'socket':
      return (await import('./socket.js')).openSocketTransport(opts);
    case 'tcp':
      return (await import('./tcp.js')).openTcpTransport(opts);
  }
}

// ── 内部共享：transport 装配与 Node 流 → web ReadableStream ─────────

export interface MakeByteTransportOptions {
  proc: SpawnedProcess;
  logger?: Logger;
  /** socket/tcp 已建立的连接；缺省 stdio 走 proc.child.stdout */
  socket?: net.Socket;
  port?: number;
  socketPath?: string;
}

/**
 * 装配统一 ByteTransport：stderr 转发 log 并累积摘录；readable/write/close/closed
 * 按 stdio 与 socket 两种底层统一。`closed` 由读流 end/error/close 或进程退出触发。
 */
export function makeByteTransport(opts: MakeByteTransportOptions): ByteTransport {
  const { proc, logger } = opts;
  const stderrLines: string[] = [];
  const onStderr = (chunk: unknown): void => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      stderrLines.push(line);
      if (stderrLines.length > 8) stderrLines.shift();
      logger?.warn(`adapter stderr: ${line}`);
    }
  };
  if (proc.child.stderr) {
    proc.child.stderr.on('data', onStderr);
  }
  if (opts.socket && proc.child.stdout) {
    // socket/tcp 模式：DAP 字节流走 socket，stdout 不再被 client 消费；显式挂丢弃型
    // data 监听持续 drain，防适配器 stdout 输出触发 OS pipe 反压（移植源 for-await
    // drain 贯穿连接生命周期同构；不依赖 Node「移除 data 监听后流仍 flowing」的隐式
    // 行为——socket 模式 stdout 从无监听（paused），无此 drain 必反压）。
    proc.child.stdout.on('data', () => {});
  }

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    resolveClosed();
  };
  void proc.exited.then(settle, settle);

  // 孤儿兜底（I-2b）：父进程异常退出后 detached 适配器被 init 收养，watcher 周期核查并
  // 强杀整棵进程树。虚拟 proc（pid=0，tcp 复连既有 server 场景）不启动。
  const orphanWatcher = proc.pid > 0 ? startOrphanWatcher(proc.pid, { logger }) : undefined;

  const source: NodeJS.ReadableStream = opts.socket ?? proc.child.stdout ?? EMPTY_READABLE;
  const readable = wrapReadable(source, settle);

  const write = (data: Uint8Array | string): void => {
    if (opts.socket) {
      opts.socket.write(data);
      return;
    }
    if (proc.child.stdin) proc.child.stdin.write(data);
  };

  let closedFlag = false;
  const close = (): void => {
    if (closedFlag) return;
    closedFlag = true;
    orphanWatcher?.stop();
    if (opts.socket) {
      try {
        opts.socket.end();
      } catch {
        /* 可能已关 */
      }
    }
    void proc.killTree().catch(() => {
      /* 已灭 */
    });
    // 清理生成的 unix socket 文件（进程被 kill 后不会自行 unlink）
    if (opts.socketPath) {
      try {
        fs.unlinkSync(opts.socketPath);
      } catch {
        /* 文件可能已不存在 */
      }
    }
  };

  const stderrExcerpt = (): string => stderrLines.slice(-4).join('\n').slice(0, 512);

  return {
    readable,
    write,
    close,
    closed,
    proc,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.socketPath !== undefined ? { socketPath: opts.socketPath } : {}),
    stderrExcerpt,
  };
}

/** Node 可读流（子进程 stdout / net.Socket）→ web ReadableStream；end/error/close 均触发 onTerminal */
function wrapReadable(source: NodeJS.ReadableStream, onTerminal: () => void): ReadableStream<Uint8Array> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      source.on('data', (chunk: unknown) => {
        try {
          controller.enqueue(chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk)));
        } catch {
          /* controller 已关闭 */
        }
      });
      source.on('end', () => {
        onTerminal();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      source.on('error', (err: unknown) => {
        onTerminal();
        try {
          controller.error(err);
        } catch {
          /* already closed */
        }
      });
      source.on('close', () => {
        onTerminal();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      onTerminal();
    },
  });
}

/** stdio 但 stdout 缺失时的空读源（防御） */
const EMPTY_READABLE: NodeJS.ReadableStream = new PassThrough();
