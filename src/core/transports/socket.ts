/**
 * socket transport：unix domain socket（DESIGN.md §8.1，移植 oh-my-pi dap/client.ts
 * 的 `#spawnSocketUnix` / `#spawnSocketClientAddr` 分支）。
 *
 * - Linux：生成 socketPath（/tmp/dap-<ts>-<rand>.sock），替换 args 中的
 *   `${socketPath}` 占位符，派生适配器，轮询等待其监听该 socket（
 *   `socketReadyTimeoutMs` 缺省 10000），再连接。就绪超时 / 连接被拒 / 适配器
 *   提前退出 → E-A2。
 * - 非 Linux（macOS 等，无 unix socket 的常规场景）：回退为本地 TCP 监听 +
 *   `--client-addr=127.0.0.1:<port>` 让适配器 dial 回来（移植源即有该逻辑，
 *   收编为内部行为，不出现在配置面）。
 *
 * 任一失败路径都会 killTree 已派生进程，避免 detached 适配器泄漏。
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { adapterConnectionError } from '../errors.js';
import type { Logger } from '../log.js';
import { spawnProcess, type SpawnedProcess } from '../process.js';
import { makeByteTransport, SOCKET_READY_TIMEOUT_MS, type ByteTransport, type OpenTransportBaseOptions } from './index.js';

export interface OpenSocketTransportOptions extends OpenTransportBaseOptions {
  /** socketPath 生成器（可注入；缺省 /tmp/dap-<name>-<ts>-<rand>.sock） */
  generateSocketPath?: (name?: string) => string;
  /** 平台注入（缺省 process.platform）；非 linux 走 macOS client-addr 回退 */
  platform?: NodeJS.Platform;
}

/** 派生 socket 适配器并等待就绪后返回字节流传输（Linux unix socket / 非 Linux client-addr） */
export async function openSocketTransport(opts: OpenSocketTransportOptions): Promise<ByteTransport> {
  const timeoutMs = opts.socketReadyTimeoutMs ?? SOCKET_READY_TIMEOUT_MS;
  const platform = opts.platform ?? process.platform;
  if (platform === 'linux') return openSocketUnix(opts, timeoutMs);
  return openSocketClientAddr(opts, timeoutMs);
}

/** 默认 unix socketPath 生成：/tmp/dap-<name>-<ts>-<rand>.sock（移植源同构） */
export function defaultSocketPath(name = 'adapter'): string {
  return path.join(os.tmpdir(), `dap-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

async function openSocketUnix(opts: OpenSocketTransportOptions, timeoutMs: number): Promise<ByteTransport> {
  const socketPath = (opts.generateSocketPath ?? defaultSocketPath)();
  const args = replaceTemplate(opts.args, '${socketPath}', socketPath);
  const proc: SpawnedProcess = spawnProcess({
    command: opts.command,
    args,
    cwd: opts.cwd,
    env: opts.env,
    logger: opts.logger,
  });
  try {
    await waitForUnixSocketReady(socketPath, timeoutMs, proc);
    const socket = await connectUnixSocket(socketPath, timeoutMs);
    return makeByteTransport({ proc, logger: opts.logger, socket, socketPath });
  } catch (error) {
    await proc.killTree().catch(() => {
      /* 可能已灭 */
    });
    // 清理已生成的 socket 文件（connect 失败/就绪超时路径文件已存在；M-2）
    await fs.unlink(socketPath).catch(() => {
      /* 文件可能已不存在 */
    });
    throw error;
  }
}

/**
 * 轮询等待 unix socket 出现（fs.stat isSocket）；适配器提前退出或超时 → E-A2。
 * 导出以便测试确定性驱动就绪路径。
 */
export async function waitForUnixSocketReady(
  socketPath: string,
  timeoutMs: number,
  proc: SpawnedProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUnixSocketReady(socketPath)) return;
    if (proc.child.exitCode !== null) {
      throw adapterConnectionError({
        transport: 'socket',
        endpoint: socketPath,
        readyTimeoutMs: timeoutMs,
        reason: 'adapter exited',
      });
    }
    await sleep(50);
  }
  throw adapterConnectionError({ transport: 'socket', endpoint: socketPath, readyTimeoutMs: timeoutMs });
}

/** 连接 unix socket；超时 / ENOENT / ECONNREFUSED / EACCES 等 → E-A2 */
export function connectUnixSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        adapterConnectionError({
          transport: 'socket',
          endpoint: socketPath,
          readyTimeoutMs: timeoutMs,
          reason: 'connect timed out',
        }),
      );
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        adapterConnectionError({
          transport: 'socket',
          endpoint: socketPath,
          readyTimeoutMs: timeoutMs,
          reason: err.code ?? err.message,
        }),
      );
    });
  });
}

/** 非 Linux 回退：本地 TCP 监听 + `--client-addr` 让适配器 dial 回来（移植源同构） */
async function openSocketClientAddr(opts: OpenSocketTransportOptions, timeoutMs: number): Promise<ByteTransport> {
  const { server, port } = await listenLoopback(0);
  const args = [...opts.args, `--client-addr=127.0.0.1:${port}`];
  const proc: SpawnedProcess = spawnProcess({
    command: opts.command,
    args,
    cwd: opts.cwd,
    env: opts.env,
    logger: opts.logger,
  });
  try {
    const socket = await acceptConnection(server, timeoutMs, port);
    server.close();
    return makeByteTransport({ proc, logger: opts.logger, socket, port });
  } catch (error) {
    server.close();
    await proc.killTree().catch(() => {
      /* 可能已灭 */
    });
    throw error;
  }
}

/** 预占 loopback 端口并监听，返回 { server, port } */
function listenLoopback(port: number): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ server, port: actual });
    });
  });
}

/** 等待首个入站连接（适配器 dial-back）；超时 → E-A2 */
function acceptConnection(server: net.Server, timeoutMs: number, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        adapterConnectionError({
          transport: 'socket',
          endpoint: `127.0.0.1:${port}`,
          readyTimeoutMs: timeoutMs,
          reason: 'client-addr dial-back timed out',
        }),
      );
    }, timeoutMs);
    server.once('connection', (socket) => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

async function isUnixSocketReady(socketPath: string): Promise<boolean> {
  try {
    return (await fs.stat(socketPath)).isSocket();
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function replaceTemplate(args: string[], token: string, value: string): string[] {
  return args.map((arg) => arg.replaceAll(token, value));
}

function isErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return (error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
