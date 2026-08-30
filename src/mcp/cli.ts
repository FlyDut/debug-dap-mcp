/**
 * CLI 参数解析（index.ts 的纯函数切片，可单元测试）。
 *
 * 支持的参数（DESIGN.md §4.1 / §8）：
 *   --config <path>          替代默认用户级配置路径（${XDG_CONFIG_HOME:-~/.config}/debug-dap-mcp/config.json）
 *   --no-project-config      禁用项目级 <cwd>/.debug-dap-mcp.json
 *   --log-level <level>      debug|info|warn|error（非法值由调用方 warn 后回落；Controller 裁决 #7）
 *   --help / -h              打印帮助并退出（帮助走 stderr，stdout 只承载 MCP 帧）
 *
 * 也支持 `--config=<path>` / `--log-level=<level>` 长格式。未知参数记入 warnings 不致命。
 * `--log-level` 的非法值在解析期记一条 warning（回落由 core/log.ts 的 parseLogLevel 完成）。
 */
import { parseLogLevel } from '../core/log.js';

export interface CliOptions {
  /** --config <path>；缺省 undefined = 使用默认用户级路径 */
  configPath?: string;
  /** --no-project-config 时 false（缺省 true） */
  loadProjectConfig: boolean;
  /** --log-level <level> 的原始值；缺省 undefined = 回落 DEBUG_DAP_MCP_LOG / info */
  logLevel?: string;
  /** --help / -h */
  help: boolean;
  /** 解析期产生的非致命告警（如非法 --log-level、未知参数），由调用方 logger.warn 逐条输出 */
  warnings: string[];
}

export function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { loadProjectConfig: true, help: false, warnings: [] };

  const takeValue = (flag: string, inline?: string): string | undefined => {
    if (inline !== undefined) return inline;
    return argv[++i];
  };

  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config' || arg.startsWith('--config=')) {
      const inline = arg.startsWith('--config=') ? arg.slice('--config='.length) : undefined;
      const value = takeValue('--config', inline);
      if (value === undefined) {
        opts.warnings.push('--config requires a path argument');
      } else {
        opts.configPath = value;
      }
      continue;
    }
    if (arg === '--no-project-config') {
      opts.loadProjectConfig = false;
      continue;
    }
    if (arg === '--log-level' || arg.startsWith('--log-level=')) {
      const inline = arg.startsWith('--log-level=') ? arg.slice('--log-level='.length) : undefined;
      const value = takeValue('--log-level', inline);
      if (value === undefined) {
        opts.warnings.push('--log-level requires a level argument');
      } else {
        opts.logLevel = value;
        if (parseLogLevel(value) !== value) {
          opts.warnings.push(`invalid --log-level '${value}', falling back to 'info'`);
        }
      }
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    opts.warnings.push(`ignoring unknown argument: ${arg}`);
  }

  return opts;
}

export const HELP_TEXT = [
  'debug-dap-mcp — DAP stdio MCP server',
  '',
  'Usage: debug-dap-mcp [options]',
  '',
  'Options:',
  '  --config <path>          override the user config file path',
  '  --no-project-config      disable project config (<cwd>/.debug-dap-mcp.json)',
  '  --log-level <level>      log level: debug | info | warn | error',
  '  --help, -h               print this help and exit',
].join('\n');
