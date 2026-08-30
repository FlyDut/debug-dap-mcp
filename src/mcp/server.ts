/**
 * MCP server 装配（DESIGN.md §6.1 / api-contract §8）。
 *
 * 创建 `debug-dap-mcp` McpServer 并注册单 `debug` 工具；传输由调用方（index.ts）选择
 * StdioServerTransport。stdout 只承载 MCP 帧（SDK 负责 JSON-RPC 封装），诊断走 stderr。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../core/session-manager.js';
import { registerDebugTool } from './tool-debug.js';

export function createDebugMcpServer(sessionManager: SessionManager): McpServer {
  const server = new McpServer({ name: 'debug-dap-mcp', version: '0.1.0' });
  registerDebugTool(server, sessionManager);
  return server;
}
