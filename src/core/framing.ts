/**
 * Content-Length 帧编解码（LSP 与 DAP stdio 共用同一 base-protocol：每个消息是
 * `Content-Length: <n>\r\n\r\n` 头块 + `<n>` 字节 UTF-8 JSON）。本模块拥有增量解码，
 * 使 client 不必各自重实现块累积、头部扫描与中途余量交接。
 * 移植自 oh-my-pi `src/jsonrpc/message-framing.ts`（零功能改动）；`encodeFrame`
 * 为按 oh-my-pi DAP client 内联写盘模式（`Content-Length: <n>\r\n\r\n`）提炼的编码器。
 */

import { Buffer } from 'node:buffer';

// 所有完整（非流式）解码复用同一 TextDecoder；每次 decode() 重置状态，
// 故单实例安全且避免逐消息分配。
const MESSAGE_DECODER = new TextDecoder("utf-8");

/**
 * 在挂起块列表中定位 `\r\n\r\n` 头终止符。返回首个 `\r` 的绝对字节下标，
 * 不存在时返回 -1。等价于扫描各块拼接的连续缓冲。
 */
function findHeaderEndInChunks(chunks: Buffer[]): number {
  let global = 0;
  let b0 = -1;
  let b1 = -1;
  let b2 = -1;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const b3 = chunk[i];
      if (b0 === 13 && b1 === 10 && b2 === 13 && b3 === 10) {
        return global - 3;
      }
      b0 = b1;
      b1 = b2;
      b2 = b3;
      global++;
    }
  }
  return -1;
}

/** 将块列表中 [from, to) 字节区间拷贝为一个 Buffer。 */
function copyChunkRange(chunks: Buffer[], from: number, to: number): Buffer {
  const out = Buffer.allocUnsafe(to - from);
  let global = 0;
  let written = 0;
  for (const chunk of chunks) {
    const chunkEnd = global + chunk.length;
    if (chunkEnd > from && global < to) {
      const start = Math.max(from, global) - global;
      const end = Math.min(to, chunkEnd) - global;
      chunk.copy(out, written, start, end);
      written += end - start;
    }
    global = chunkEnd;
    if (global >= to) break;
  }
  return out;
}

/** 就地丢弃挂起块列表前 `count` 字节。 */
function dropChunkFront(chunks: Buffer[], count: number): void {
  let removed = 0;
  while (chunks.length > 0) {
    const head = chunks[0];
    if (removed + head.length <= count) {
      removed += head.length;
      chunks.shift();
    } else {
      chunks[0] = head.subarray(count - removed);
      break;
    }
  }
}

/** 把消息对象编码为一条 Content-Length 帧（头以 latin1 写入，体为 UTF-8 JSON 字节）。 */
export function encodeFrame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "latin1");
  return Buffer.concat([head, body]);
}

/**
 * JSON 消息字节流的增量 Content-Length 帧解码器。
 *
 * 入站字节以块列表缓冲，仅在整条消息可成帧时才拼接——每次读取都拼接累加器
 * 对跨多读取的消息是 O(n^2)（例如大块初始诊断突发）。用 {@link push} 喂原始块，
 * 用 {@link drain} 取出每条完整消息，读取方停止时用 {@link remainder} 持久化，
 * 以便重启的读取方从消息中途续读。
 */
export class MessageFramer {
  readonly #pendingChunks: Buffer[] = [];
  #pendingLen = 0;

  /** 用前一个读取方留下的未解析余量做种子。 */
  constructor(seed: Buffer) {
    if (seed.length > 0) {
      this.#pendingChunks.push(seed);
      this.#pendingLen = seed.length;
    }
  }

  /** 追加新读到的块到挂起缓冲。 */
  push(chunk: Buffer): void {
    this.#pendingChunks.push(chunk);
    this.#pendingLen += chunk.length;
  }

  /**
   * 产出当前已缓冲的每条完整消息的 JSON 文本。无 `Content-Length` 的头块是
   * 非协议噪音（如 server 打印到 stdout）；`onResync` 收到问题头文本，framer
   * 丢弃至坏终止符之后以恢复，而不是永远卡在同一垃圾头上。
   */
  *drain(onResync: (headerText: string) => void): Generator<string> {
    while (true) {
      const headerEnd = findHeaderEndInChunks(this.#pendingChunks);
      if (headerEnd === -1) break;

      const headerText = MESSAGE_DECODER.decode(copyChunkRange(this.#pendingChunks, 0, headerEnd));
      const contentLengthMatch = headerText.match(/Content-Length: (\d+)/i);
      if (!contentLengthMatch) {
        onResync(headerText);
        dropChunkFront(this.#pendingChunks, headerEnd + 4);
        this.#pendingLen -= headerEnd + 4;
        continue;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4; // Skip \r\n\r\n
      const messageEnd = messageStart + contentLength;
      if (this.#pendingLen < messageEnd) break;

      const messageText = MESSAGE_DECODER.decode(copyChunkRange(this.#pendingChunks, messageStart, messageEnd));
      dropChunkFront(this.#pendingChunks, messageEnd);
      this.#pendingLen -= messageEnd;
      yield messageText;
    }
  }

  /** 未解析的余量，读取方停止时持久化用。 */
  remainder(): Buffer {
    return this.#pendingChunks.length === 0
      ? Buffer.alloc(0)
      : this.#pendingChunks.length === 1
        ? this.#pendingChunks[0]
        : Buffer.concat(this.#pendingChunks, this.#pendingLen);
  }
}
