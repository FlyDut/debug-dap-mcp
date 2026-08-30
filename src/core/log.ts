/**
 * stderr 极简日志（DESIGN.md §7.2 固化，api-contract §4.4）。
 *
 * stdout 只承载 MCP 帧；一切诊断写 stderr。级别由显式 level（--log-level）优先，
 * 否则读 `DEBUG_DAP_MCP_LOG`，再缺省 info。debug 级供上层输出 DAP 帧收发摘要与
 * 适配器 spawn 的最终命令行（模板展开后，便于回放）。sink 可注入以便测试
 * （collector / no-op logger）。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 行写入口；默认写 stderr。 */
export type LogSink = (line: string) => void;

/** 日志接口（api-contract §4.4）；debug 级承载帧摘要/最终命令行等诊断 */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface CreateLoggerOptions {
  /** 显式级别；缺省读 DEBUG_DAP_MCP_LOG；再缺省 info */
  level?: LogLevel | string;
  /** 行写入口；缺省写 stderr */
  sink?: LogSink;
}

const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const VALID_LEVELS: ReadonlySet<string> = new Set(Object.keys(LOG_LEVEL_RANK));

/** 解析级别字符串；非法/缺失回退 "info"（供 CLI --log-level 与 DEBUG_DAP_MCP_LOG 共用） */
export function parseLogLevel(value: string | undefined): LogLevel {
  if (value !== undefined && VALID_LEVELS.has(value)) return value as LogLevel;
  return "info";
}

/** 构造 Logger；永不写 stdout（默认 sink 只写 stderr） */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const envLevel = typeof process !== "undefined" ? process.env.DEBUG_DAP_MCP_LOG : undefined;
  const level = parseLogLevel(options.level ?? envLevel);
  const threshold = LOG_LEVEL_RANK[level];
  const sink: LogSink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));

  function emit(tag: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVEL_RANK[tag] < threshold) return;
    const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
    sink(`[${tag}] ${message}${suffix}`);
  }

  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
  };
}
