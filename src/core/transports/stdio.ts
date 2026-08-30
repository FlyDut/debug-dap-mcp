/**
 * stdio transport（DESIGN.md §8.1，移植 oh-my-pi dap/client.ts stdio 分支）。
 *
 * 包裹适配器子进程的 stdin/stdout 为统一 ByteTransport：`spawnProcess`（detached
 * 建组、非交互环境，src/core/process.ts）派生进程，stdout 经 web ReadableStream
 * 暴露，stderr 由 makeByteTransport 转发 log 并累积摘录。无"就绪等待"阶段——
 * stdio 模式 spawn 即就绪。
 */

import type { Logger } from '../log.js';
import { spawnProcess, type SpawnedProcess } from '../process.js';
import { makeByteTransport, type ByteTransport, type OpenTransportBaseOptions } from './index.js';

export interface OpenStdioTransportOptions extends OpenTransportBaseOptions {}

/** 派生 stdio 适配器并返回字节流传输（spawn 即就绪） */
export async function openStdioTransport(opts: OpenStdioTransportOptions): Promise<ByteTransport> {
  const proc: SpawnedProcess = spawnProcess({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    logger: opts.logger,
  });
  return makeByteTransport({ proc, logger: opts.logger });
}
