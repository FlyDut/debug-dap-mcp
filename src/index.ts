#!/usr/bin/env node
/**
 * CLI 入口（DESIGN.md §8 / api-contract §8，Task 13）。
 *
 * 装配链：parseCliArgs（可测纯函数）→ createLogger（stderr）→ AdapterRegistry
 * （内置 < 用户级 < 项目级三层）→ SessionManager（createNodeDapClient 工厂）→
 * McpServer + StdioServerTransport。stdin EOF（MCP 客户端退出）→ sessionManager.dispose()
 * （停清扫循环、整树 terminate + 进程树强杀兜底）→ 进程退出。stdout 只承载 MCP 帧；
 * 一切日志（含 --help）走 stderr。不 re-export NodeDapClient（Task 10 收口）。
 */
import process from 'node:process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_SETTINGS } from './core/adapter-schema.js';
import { AdapterRegistry, type Settings } from './core/adapter-registry.js';
import { createNodeDapClient, type ClientFactory } from './core/client.js';
import { createFatalErrorHandler } from './core/fatal-errors.js';
import { createLogger, type Logger } from './core/log.js';
import { SessionManager } from './core/session-manager.js';
import { parseCliArgs, HELP_TEXT } from './mcp/cli.js';
import { createDebugMcpServer } from './mcp/server.js';

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const logger: Logger = createLogger({ level: cli.logLevel });
  for (const warning of cli.warnings) logger.warn(warning);

  if (cli.help) {
    process.stderr.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }

  const registry = new AdapterRegistry({
    settings: DEFAULT_SETTINGS as Settings,
    logger,
    loadProjectConfig: cli.loadProjectConfig,
    // 环境快照：缺省 {} 时 userConfigPathFromEnv 读不到 XDG_CONFIG_HOME/HOME → 用户级
    // 默认配置静默不加载（D-1）；envPath 一并快照，findExecutable 回落不再隐式依赖全局
    env: process.env,
    envPath: process.env.PATH,
    ...(cli.configPath !== undefined ? { userConfigPath: cli.configPath } : {}),
  });

  const clientFactory: ClientFactory = (options) => createNodeDapClient({ ...options, logger });

  const sessionManager = new SessionManager({
    clientFactory,
    registry,
    logger,
    settings: registry.settings,
  });

  const server = createDebugMcpServer(sessionManager);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('debug-dap-mcp server started on stdio');

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await sessionManager.dispose();
    } catch (error) {
      logger.error('error during shutdown', { error: String(error) });
    } finally {
      process.exit(0);
    }
  };

  process.stdin.on('end', () => {
    void shutdown();
  });
  process.stdin.on('close', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  // 致命错误兜底（I-2a）：uncaughtException/unhandledRejection 收敛为 error 日志 +
  // dispose（幂等）+ exit(1)，防异常退出时 detached 适配器泄漏
  const fatal = createFatalErrorHandler({
    logger,
    dispose: () => sessionManager.dispose(),
    exit: (code) => process.exit(code),
  });
  process.on('uncaughtException', fatal.onUncaughtException);
  process.on('unhandledRejection', fatal.onUnhandledRejection);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[error] ${message}\n`);
  process.exit(1);
});
