/**
 * 致命错误兜底（I-2a）：uncaughtException / unhandledRejection → 记 error 日志 →
 * dispose（幂等）→ exit(1)。独立模块便于注入式单测（不真杀进程）；生产装配由
 * index.ts 将返回的 handler 挂到 process 事件。
 */

import type { Logger } from './log.js';

export interface FatalErrorHandlerDeps {
  logger: Logger;
  /** 资源清理（SessionManager.dispose 幂等：杀树 + 清 transport + 停清扫循环） */
  dispose: () => Promise<void>;
  /** 退出注入（测试传 mock；生产传 process.exit） */
  exit: (code: number) => void;
}

export interface FatalErrorHandler {
  onUncaughtException: (error: unknown) => void;
  onUnhandledRejection: (reason: unknown) => void;
}

export function createFatalErrorHandler(deps: FatalErrorHandlerDeps): FatalErrorHandler {
  let settled = false;
  const fatal = (event: 'exception' | 'rejection', value: unknown): void => {
    if (settled) return;
    settled = true;
    const message = value instanceof Error ? (value.stack ?? value.message) : String(value);
    deps.logger.error(`fatal: uncaught ${event}`, { error: message });
    void deps
      .dispose()
      .catch(() => {
        /* 清理失败也必须退出 */
      })
      .finally(() => deps.exit(1));
  };
  return {
    onUncaughtException: (error) => fatal('exception', error),
    onUnhandledRejection: (reason) => fatal('rejection', reason),
  };
}