/**
 * tcp transport（DESIGN.md §8.1，移植 oh-my-pi dap/client.ts 的 `#spawnTcp` 分支）。
 *
 * 预占 loopback 空闲端口（供 args 中 `${port}` 模板替换），派生适配器，banner
 * 等待（best-effort drain stdout，兼防 pipe 阻塞）与连接轮询并行进行，就绪即连。
 * 就绪超时 / 连接被拒 / 适配器提前退出 → E-A2。失败路径 killTree 已派生进程。
 */

import * as net from 'node:net';
import { adapterConnectionError } from '../errors.js';
import type { Logger } from '../log.js';
import { spawnProcess, type SpawnedProcess } from '../process.js';
import { makeByteTransport, SOCKET_READY_TIMEOUT_MS, type ByteTransport, type OpenTransportBaseOptions } from './index.js';

export interface OpenTcpTransportOptions extends OpenTransportBaseOptions {
  /** 端口预占器（可注入以便测试）；缺省真实预占 loopback 空闲端口 */
  reservePort?: () => Promise<number>;
}

/** 预占 loopback 空闲端口（listen :0 → 记 port → 关闭），返回可用端口（供 ${port} 模板） */
export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 预占端口、派生适配器并等待其监听后连接，返回字节流传输 */
export async function openTcpTransport(opts: OpenTcpTransportOptions): Promise<ByteTransport> {
  const timeoutMs = opts.socketReadyTimeoutMs ?? SOCKET_READY_TIMEOUT_MS;
  const port = await (opts.reservePort ?? reserveLoopbackPort)();
  const args = opts.args.map((arg) => arg.replaceAll('${port}', String(port)));
  const proc: SpawnedProcess = spawnProcess({
    command: opts.command,
    args,
    cwd: opts.cwd,
    env: opts.env,
    logger: opts.logger,
  });
  try {
    // banner 等待与连接轮询并行：无 banner 适配器（如 debugpy）不必串行白等满
    // socketReadyTimeoutMs。banner promise 仅作 stdout drain 与幽灵连接窗口缓解，
    // 永不 reject（超时/进程退出/end 均放行）且不 await——无 banner 适配器下
    // 等它 settle 即白等满超时，故让其自飘（rejection 已挂 .catch 兜底）。
    // 轮询首试 ECONNREFUSED 属正常重试，与无 banner 适配器的既有行为一致。
    const bannerDrain = waitForTcpServerListening(proc, port, timeoutMs);
    bannerDrain.catch(() => {});
    const socket = await waitForTcpConnect('127.0.0.1', port, timeoutMs, proc);
    return makeByteTransport({ proc, logger: opts.logger, socket, port });
  } catch (error) {
    await proc.killTree().catch(() => {
      /* 可能已灭 */
    });
    throw error;
  }
}

/**
 * Drain 适配器 stdout 直至出现端口 banner（如 vscode-js-debug 的
 * "Debug server listening at HOST:PORT"），以关闭"预占端口幽灵连接"竞态窗口。
 * Best-effort：进程退出 / stdout 结束 / 超时均放行，后续连接循环与 exitCode 检查
 * 兜底真实失败（移植源 waitForTcpServerListening 同构）。导出以便测试确定性驱动。
 */
export async function waitForTcpServerListening(
  proc: SpawnedProcess,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const portText = String(port);
  await new Promise<void>((resolve) => {
    const out = proc.child.stdout;
    if (!out) {
      resolve();
      return;
    }
    let buffered = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      out.removeListener('data', onData);
      out.removeListener('end', onEnd);
      out.removeListener('error', onError);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const onData = (chunk: unknown): void => {
      buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (buffered.includes(portText)) {
        finish();
        return;
      }
      if (buffered.length > 4096) buffered = buffered.slice(-1024);
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish();
    out.on('data', onData);
    out.on('end', onEnd);
    out.on('error', onError);
  });
}

/** 轮询连接 TCP 端口直至成功；适配器提前退出或超时 → E-A2（连接被拒视作未就绪，重试） */
export async function waitForTcpConnect(
  host: string,
  port: number,
  timeoutMs: number,
  proc: SpawnedProcess,
): Promise<net.Socket> {
  const endpoint = `${host}:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null) {
      throw adapterConnectionError({
        transport: 'tcp',
        endpoint,
        readyTimeoutMs: timeoutMs,
        reason: 'adapter exited',
      });
    }
    try {
      return await connectTcp(host, port);
    } catch {
      await sleep(50);
    }
  }
  throw adapterConnectionError({ transport: 'tcp', endpoint, readyTimeoutMs: timeoutMs });
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.destroy();
      reject(err);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
