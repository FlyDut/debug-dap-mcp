/**
 * 适配器配置 zod schema（DESIGN.md §4.1/§4.2 固化，api-contract §4.3）。
 *
 * 顶层两部分：`settings`（附录 A 全键 + DESIGN §4.1 默认值；binaryPreference、
 * attachPreference.{withPort,withPid}、allowRunInTerminal 默认 true）与 `adapters` 记录
 * （§4.2 全字段：command/args/languages/fileTypes/rootMarkers/transport/
 * acceptsDirectoryProgram/launchDefaults/attachDefaults/launchRules/commandResolution/
 * pidArgument）。
 * pidArgument（§4.4）：pid 参数映射到该适配器 attach 请求体的字段名（差异即数据，
 * 例：dlv 用 processId）；缺省 "pid"。
 *
 * strict 模式（未知键拒绝）——与 MCP 层参数校验的全局 strict 口径一致（Task 5 M-Z 系列）。
 * zod v4（z.record 需两参）。`DEFAULT_SETTINGS` 为内置 settings 默认值（附录 A / §4.1），
 * AdapterRegistry 以它为"内置 < 用户级 < 项目级"三层合并的最底层。
 */

import { z } from 'zod';

/** 内置 settings 默认值（DESIGN.md 附录 A + §4.1 示例） */
export const DEFAULT_SETTINGS = {
  idleTimeoutMs: 600000,
  cleanupIntervalMs: 30000,
  terminatedRetentionMs: 300000,
  heartbeatIntervalMs: 5000,
  stopCaptureTimeoutMs: 5000,
  requestTimeoutMs: 30000,
  socketReadyTimeoutMs: 10000,
  maxOutputBytes: 131072,
  binaryPreference: ['gdb', 'lldb-dap'],
  attachPreference: { withPort: ['debugpy'], withPid: ['gdb', 'lldb-dap'] },
  allowRunInTerminal: true,
};

/** 顶层 settings 校验（strict：未知键拒绝；缺省键回落默认） */
export const settingsSchema = z
  .object({
    idleTimeoutMs: z.number().default(() => DEFAULT_SETTINGS.idleTimeoutMs),
    cleanupIntervalMs: z.number().default(() => DEFAULT_SETTINGS.cleanupIntervalMs),
    terminatedRetentionMs: z.number().default(() => DEFAULT_SETTINGS.terminatedRetentionMs),
    heartbeatIntervalMs: z.number().default(() => DEFAULT_SETTINGS.heartbeatIntervalMs),
    stopCaptureTimeoutMs: z.number().default(() => DEFAULT_SETTINGS.stopCaptureTimeoutMs),
    requestTimeoutMs: z.number().default(() => DEFAULT_SETTINGS.requestTimeoutMs),
    socketReadyTimeoutMs: z.number().default(() => DEFAULT_SETTINGS.socketReadyTimeoutMs),
    maxOutputBytes: z.number().default(() => DEFAULT_SETTINGS.maxOutputBytes),
    binaryPreference: z.array(z.string()).default(() => [...DEFAULT_SETTINGS.binaryPreference]),
    attachPreference: z
      .object({
        withPort: z.array(z.string()).default(() => [...DEFAULT_SETTINGS.attachPreference.withPort]),
        withPid: z.array(z.string()).default(() => [...DEFAULT_SETTINGS.attachPreference.withPid]),
      })
      .default(() => ({
        withPort: [...DEFAULT_SETTINGS.attachPreference.withPort],
        withPid: [...DEFAULT_SETTINGS.attachPreference.withPid],
      })),
    allowRunInTerminal: z.boolean().default(() => DEFAULT_SETTINGS.allowRunInTerminal),
  })
  .strict();

export const transportSchema = z.enum(['stdio', 'socket', 'tcp']);

/** commandResolution（DESIGN.md §4.2；与 core/command.ts 的 AdapterCommandResolution 同构） */
export const commandResolutionSchema = z
  .object({
    envVar: z.string().optional(),
    candidates: z.array(z.string()).optional(),
    installHint: z.string().optional(),
  })
  .strict();

/** launchRules[].when：programShape = directory | file（file 可叠加 extensions） */
export const launchRuleSchema = z
  .object({
    when: z
      .object({
        programShape: z.enum(['directory', 'file']),
        extensions: z.array(z.string()).optional(),
      })
      .strict(),
    defaults: z.record(z.string(), z.unknown()),
  })
  .strict();

/** 适配器记录（DESIGN.md §4.2 全字段；transport 缺省 stdio） */
export const adapterSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    fileTypes: z.array(z.string()).optional(),
    rootMarkers: z.array(z.string()).optional(),
    transport: transportSchema.default('stdio'),
    acceptsDirectoryProgram: z.boolean().optional(),
    launchDefaults: z.record(z.string(), z.unknown()).optional(),
    attachDefaults: z.record(z.string(), z.unknown()).optional(),
    launchRules: z.array(launchRuleSchema).optional(),
    commandResolution: commandResolutionSchema.optional(),
    pidArgument: z.string().min(1).optional(),
    /** 适配器进程环境叠加层（值支持模板，如 ${env:NAME}）；叠加在 MCP 进程环境之上 */
    env: z.record(z.string(), z.string()).optional(),
    /**
     * attach 会话的 adapter 侧连接来源（§4.4；缺省 spawn）：
     * - spawn：MCP 拉起适配器进程，attach 请求体驱动（pid 注入 / 请求体 port）；
     * - connect：MCP 复连既有 DAP server（port = DAP 端点），不 spawn 适配器。
     */
    attachConnection: z.enum(['spawn', 'connect']).optional(),
  })
  .strict();

/** 适配器记录集：name → 记录 */
export const adaptersSchema = z.record(z.string(), adapterSchema);

/** 解析后（zod 输出）的记录类型 */
export type ParsedAdapterRecord = z.infer<typeof adapterSchema>;
export type ParsedLaunchRule = z.infer<typeof launchRuleSchema>;
export type ParsedCommandResolution = z.infer<typeof commandResolutionSchema>;
export type ParsedSettings = z.infer<typeof settingsSchema>;
