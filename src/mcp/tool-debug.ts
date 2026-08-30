/**
 * MCP 装配层：单 `debug` 工具（DESIGN.md §6.1，api-contract §5/§6/§7）。
 *
 * 30 个 action 的严格 zod discriminatedUnion（参数 camelCase，按 api-contract §5 逐表），
 * 运行时校验失败 → E-U1（unknown 字段/类型错/边界）与 E-U2（未知 action）；
 * dispatch 表把 action 映射到 SessionManager 的 30 个方法（§4.6.7）；
 * timeout clamp [5000, 300000]（缺省 30000）后以 CallOptions.timeoutMs 透传（M-T 系，§2）；
 * 结果与错误都渲染为「同源两份」——structuredContent 与 content[0].text 的 JSON 序列化（§7）。
 *
 * capability 门控不在本层（SessionManager 内部实现，core C14 系已绿；M-CAP 由测试替身
 * 模拟），本层只做直透调用 + 错误渲染（Controller 裁决 #1）。E-U3 变体（attach 的
 * pid/port 二选一、data_breakpoint_info 的 name/variablesReference 至少给一）在解析后
 * 手工校验（Controller 裁决 #4）。
 *
 * 注册形态：直接操作底层 Server 的 ListTools/CallTool handler，避免 SDK tool() 的自动
 * zod 校验拦截（SDK 校验失败会渲染为 MCP error 文本，与 §3.7 错误体契约不符）。
 * inputSchema 为「平铺枚举」JSON Schema（action enum + 全字段 optional +
 * additionalProperties:false），由 30 分支 schema 的 toJSONSchema 合并生成（M-LIST）。
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../core/session-manager.js';
import type { AttachInput, CallOptions, LaunchInput, StartOptions } from '../core/session-manager.js';
import {
  attachTargetError,
  DebugToolError,
  invalidArgumentsError,
  toToolErrorBody,
  unknownActionError,
} from '../core/errors.js';

// ── 常量（api-contract §2 / §4.1）────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 30_000;
export const TIMEOUT_CLAMP_MIN_MS = 5_000;
export const TIMEOUT_CLAMP_MAX_MS = 300_000;

/** 31 个 action 的精确枚举（api-contract §5；E-U2 的 details.availableActions） */
export const ACTIONS = [
  'launch',
  'attach',
  'terminate',
  'sessions',
  'set_breakpoint',
  'remove_breakpoint',
  'set_function_breakpoint',
  'remove_function_breakpoint',
  'set_instruction_breakpoint',
  'remove_instruction_breakpoint',
  'data_breakpoint_info',
  'set_data_breakpoint',
  'remove_data_breakpoint',
  'continue',
  'pause',
  'step_over',
  'step_in',
  'step_out',
  'stack_trace',
  'threads',
  'scopes',
  'variables',
  'evaluate',
  'exception_info',
  'output',
  'disassemble',
  'read_memory',
  'write_memory',
  'modules',
  'loaded_sources',
  'custom_request',
] as const;

type ActionName = (typeof ACTIONS)[number];

// ── 字段级 schema（api-contract §5 逐表；strict：未知字段拒绝 → M-Z2）────────

const timeoutField = z.number();
const sessionIdField = z.string().optional();
const commonFields = { sessionId: sessionIdField, timeout: timeoutField.optional() };

const launchSchema = z.strictObject({
  action: z.literal('launch'),
  program: z.string().min(1),
  args: z.array(z.string()).optional(),
  adapter: z.string().optional(),
  cwd: z.string().optional(),
  /** 显式 DAP 请求体覆盖（DESIGN §4.1：最高优先层；键级浅覆盖，与协议字段一一对应） */
  dapArguments: z.record(z.string(), z.unknown()).optional(),
  timeout: timeoutField.optional(),
});

const attachSchema = z.strictObject({
  action: z.literal('attach'),
  pid: z.number().int().positive().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  host: z.string().optional(),
  adapter: z.string().optional(),
  cwd: z.string().optional(),
  /** 显式 DAP 请求体覆盖（DESIGN §4.1：最高优先层；键级浅覆盖，与协议字段一一对应） */
  dapArguments: z.record(z.string(), z.unknown()).optional(),
  timeout: timeoutField.optional(),
});

const terminateSchema = z.strictObject({ action: z.literal('terminate'), ...commonFields });
const sessionsSchema = z.strictObject({ action: z.literal('sessions') });

const setBreakpointSchema = z.strictObject({
  action: z.literal('set_breakpoint'),
  file: z.string(),
  line: z.number().int().positive(),
  condition: z.string().optional(),
  hitCondition: z.string().optional(),
  ...commonFields,
});

const removeBreakpointSchema = z.strictObject({
  action: z.literal('remove_breakpoint'),
  file: z.string(),
  line: z.number().int().positive(),
  ...commonFields,
});

const setFunctionBreakpointSchema = z.strictObject({
  action: z.literal('set_function_breakpoint'),
  name: z.string(),
  condition: z.string().optional(),
  hitCondition: z.string().optional(),
  ...commonFields,
});

const removeFunctionBreakpointSchema = z.strictObject({
  action: z.literal('remove_function_breakpoint'),
  name: z.string(),
  ...commonFields,
});

const setInstructionBreakpointSchema = z.strictObject({
  action: z.literal('set_instruction_breakpoint'),
  instructionReference: z.string(),
  offset: z.number().int().optional(),
  condition: z.string().optional(),
  ...commonFields,
});

const removeInstructionBreakpointSchema = z.strictObject({
  action: z.literal('remove_instruction_breakpoint'),
  instructionReference: z.string(),
  offset: z.number().int().optional(),
  ...commonFields,
});

const dataBreakpointInfoSchema = z.strictObject({
  action: z.literal('data_breakpoint_info'),
  name: z.string().optional(),
  variablesReference: z.number().int().optional(),
  ...commonFields,
});

const setDataBreakpointSchema = z.strictObject({
  action: z.literal('set_data_breakpoint'),
  dataId: z.string(),
  accessType: z.enum(['read', 'write', 'readWrite']).optional(),
  condition: z.string().optional(),
  ...commonFields,
});

const removeDataBreakpointSchema = z.strictObject({
  action: z.literal('remove_data_breakpoint'),
  dataId: z.string(),
  ...commonFields,
});

const stepSchema = (action: string) =>
  z.strictObject({ action: z.literal(action), threadId: z.number().int().optional(), ...commonFields });

const continueSchema = stepSchema('continue');
const pauseSchema = stepSchema('pause');
const stepOverSchema = stepSchema('step_over');
const stepInSchema = stepSchema('step_in');
const stepOutSchema = stepSchema('step_out');

const stackTraceSchema = z.strictObject({
  action: z.literal('stack_trace'),
  threadId: z.number().int().optional(),
  levels: z.number().int().positive().optional(),
  ...commonFields,
});

const threadsSchema = z.strictObject({ action: z.literal('threads'), ...commonFields });
const loadedSourcesSchema = z.strictObject({ action: z.literal('loaded_sources'), ...commonFields });

const scopesSchema = z.strictObject({
  action: z.literal('scopes'),
  frameId: z.number().int().optional(),
  ...commonFields,
});

const variablesSchema = z.strictObject({
  action: z.literal('variables'),
  variablesReference: z.number().int(),
  start: z.number().int().nonnegative().optional(),
  count: z.number().int().positive().optional(),
  ...commonFields,
});

const evaluateSchema = z.strictObject({
  action: z.literal('evaluate'),
  expression: z.string(),
  frameId: z.number().int().optional(),
  context: z.enum(['repl', 'watch', 'hover', 'clipboard', 'variables']).optional(),
  ...commonFields,
});

const exceptionInfoSchema = z.strictObject({
  action: z.literal('exception_info'),
  threadId: z.number().int().optional(),
  ...commonFields,
});

const outputSchema = z.strictObject({
  action: z.literal('output'),
  tail: z.number().int().positive().optional(),
  ...commonFields,
});

const disassembleSchema = z.strictObject({
  action: z.literal('disassemble'),
  memoryReference: z.string(),
  instructionCount: z.number().int().positive().optional(),
  instructionOffset: z.number().int().optional(),
  offset: z.number().int().optional(),
  resolveSymbols: z.boolean().optional(),
  ...commonFields,
});

const readMemorySchema = z.strictObject({
  action: z.literal('read_memory'),
  memoryReference: z.string(),
  count: z.number().int().positive().optional(),
  offset: z.number().int().optional(),
  ...commonFields,
});

const writeMemorySchema = z.strictObject({
  action: z.literal('write_memory'),
  memoryReference: z.string(),
  data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
  offset: z.number().int().optional(),
  ...commonFields,
});

const modulesSchema = z.strictObject({
  action: z.literal('modules'),
  startModule: z.number().int().nonnegative().optional(),
  moduleCount: z.number().int().positive().optional(),
  ...commonFields,
});

const customRequestSchema = z.strictObject({
  action: z.literal('custom_request'),
  command: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
  ...commonFields,
});

/** 31 分支 discriminated union——handler 内唯一校验入口（E-U1/E-U2） */
const requestSchema = z.discriminatedUnion('action', [
  launchSchema,
  attachSchema,
  terminateSchema,
  sessionsSchema,
  setBreakpointSchema,
  removeBreakpointSchema,
  setFunctionBreakpointSchema,
  removeFunctionBreakpointSchema,
  setInstructionBreakpointSchema,
  removeInstructionBreakpointSchema,
  dataBreakpointInfoSchema,
  setDataBreakpointSchema,
  removeDataBreakpointSchema,
  continueSchema,
  pauseSchema,
  stepOverSchema,
  stepInSchema,
  stepOutSchema,
  stackTraceSchema,
  threadsSchema,
  scopesSchema,
  variablesSchema,
  evaluateSchema,
  exceptionInfoSchema,
  outputSchema,
  disassembleSchema,
  readMemorySchema,
  writeMemorySchema,
  modulesSchema,
  loadedSourcesSchema,
  customRequestSchema,
]);

const TOOL_DESCRIPTION =
  'DAP (Debug Adapter Protocol) control surface. Pass one of 31 `action`s plus their camelCase ' +
  'parameters; returns a JSON payload (structuredContent mirrors it). Sessions are launched via ' +
  '`launch`/`attach` and targeted by `sessionId` (default: focused session).';

// ── timeout clamp（M-T 系；api-contract §2）──────────────────────────────────

export function clampTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(value, TIMEOUT_CLAMP_MIN_MS), TIMEOUT_CLAMP_MAX_MS);
}

// ── inputSchema 生成（M-LIST：平铺枚举形态，action 用顶层 enum）──────────────

function buildInputSchema(): { type: 'object'; [key: string]: unknown } {
  const raw = requestSchema.toJSONSchema() as { oneOf?: Array<Record<string, unknown>> };
  const props: Record<string, unknown> = {};
  for (const branch of raw.oneOf ?? []) {
    for (const [key, value] of Object.entries((branch.properties ?? {}) as Record<string, unknown>)) {
      if (key !== 'action') props[key] = value;
    }
  }
  return {
    type: 'object',
    required: ['action'],
    properties: { action: { enum: [...ACTIONS] }, ...props },
    additionalProperties: false,
  };
}

// ── 参数解析（E-U1 / E-U2）───────────────────────────────────────────────────

/**
 * zod 4 的 strict 未知字段 issue 不带 path（单 key message 形如 `Unrecognized key: "X"`，
 * 多 key 为复数 `Unrecognized keys: "a", "b"` 且附带结构化 `keys` 数组、code 为
 * `unrecognized_keys`）。契约（E-U1）要求 details.issues[].path 逐字段携带路径——
 * 直接消费结构化 `keys`，把单个 issue 展开为每 key 一条。
 */
function normalizeIssue(issue: z.core.$ZodIssue): Array<{ path: Array<string | number>; message: string }> {
  if (issue.code === 'unrecognized_keys' && Array.isArray((issue as { keys?: unknown }).keys)) {
    return (issue as unknown as { keys: string[] }).keys.map((key) => ({ path: [key], message: issue.message }));
  }
  return [{ path: [...issue.path] as Array<string | number>, message: issue.message }];
}

function parseArgs(args: unknown): { action: ActionName; data: Record<string, unknown> } {
  if (args === null || typeof args !== 'object') {
    throw invalidArgumentsError([{ path: [], message: 'expected an object of arguments' }]);
  }
  const action = (args as Record<string, unknown>).action;
  if (typeof action === 'string' && !(ACTIONS as readonly string[]).includes(action)) {
    throw unknownActionError(action, [...ACTIONS]);
  }
  const result = requestSchema.safeParse(args);
  if (!result.success) {
    throw invalidArgumentsError(result.error.issues.flatMap(normalizeIssue));
  }
  const data = result.data as unknown as Record<string, unknown>;
  return { action: data.action as ActionName, data };
}

// ── dispatch（SessionManager 30 方法，api-contract §4.6.7）──────────────────

function callOpts(data: Record<string, unknown>): CallOptions {
  return {
    ...(typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
    timeoutMs: clampTimeout(typeof data.timeout === 'number' ? data.timeout : undefined),
  };
}

type Data = Record<string, unknown>;
const str = (d: Data, k: string): string | undefined => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
const num = (d: Data, k: string): number | undefined => (typeof d[k] === 'number' ? (d[k] as number) : undefined);
const bool = (d: Data, k: string): boolean | undefined => (typeof d[k] === 'boolean' ? (d[k] as boolean) : undefined);
const strArr = (d: Data, k: string): string[] | undefined => (Array.isArray(d[k]) ? (d[k] as string[]) : undefined);
const obj = (d: Data, k: string): Record<string, unknown> | undefined =>
  typeof d[k] === 'object' && d[k] !== null && !Array.isArray(d[k]) ? (d[k] as Record<string, unknown>) : undefined;

async function dispatch(manager: SessionManager, action: ActionName, d: Data): Promise<unknown> {
  switch (action) {
    case 'launch': {
      const input: LaunchInput = {
        program: str(d, 'program') as string,
        ...(strArr(d, 'args') !== undefined ? { args: strArr(d, 'args') as string[] } : {}),
        ...(str(d, 'adapter') !== undefined ? { adapter: str(d, 'adapter') as string } : {}),
        ...(str(d, 'cwd') !== undefined ? { cwd: str(d, 'cwd') as string } : {}),
        ...(obj(d, 'dapArguments') !== undefined ? { dapArguments: obj(d, 'dapArguments') as Record<string, unknown> } : {}),
      };
      const opts: StartOptions = { timeoutMs: clampTimeout(num(d, 'timeout')) };
      return manager.launch(input, opts);
    }
    case 'attach': {
      const hasPid = num(d, 'pid') !== undefined;
      const hasPort = num(d, 'port') !== undefined;
      if (hasPid === hasPort) throw attachTargetError();
      const input: AttachInput = {
        ...(hasPid ? { pid: num(d, 'pid') as number } : {}),
        ...(hasPort ? { port: num(d, 'port') as number } : {}),
        ...(str(d, 'host') !== undefined ? { host: str(d, 'host') as string } : {}),
        ...(str(d, 'adapter') !== undefined ? { adapter: str(d, 'adapter') as string } : {}),
        ...(str(d, 'cwd') !== undefined ? { cwd: str(d, 'cwd') as string } : {}),
        ...(obj(d, 'dapArguments') !== undefined ? { dapArguments: obj(d, 'dapArguments') as Record<string, unknown> } : {}),
      };
      const opts: StartOptions = { timeoutMs: clampTimeout(num(d, 'timeout')) };
      return manager.attach(input, opts);
    }
    case 'terminate':
      return manager.terminate(callOpts(d));
    case 'sessions':
      return manager.sessions();
    case 'set_breakpoint':
      return manager.setBreakpoint(
        str(d, 'file') as string,
        num(d, 'line') as number,
        str(d, 'condition'),
        str(d, 'hitCondition'),
        callOpts(d),
      );
    case 'remove_breakpoint':
      return manager.removeBreakpoint(str(d, 'file') as string, num(d, 'line') as number, callOpts(d));
    case 'set_function_breakpoint':
      return manager.setFunctionBreakpoint(
        str(d, 'name') as string,
        str(d, 'condition'),
        str(d, 'hitCondition'),
        callOpts(d),
      );
    case 'remove_function_breakpoint':
      return manager.removeFunctionBreakpoint(str(d, 'name') as string, callOpts(d));
    case 'set_instruction_breakpoint':
      return manager.setInstructionBreakpoint(
        str(d, 'instructionReference') as string,
        num(d, 'offset'),
        str(d, 'condition'),
        callOpts(d),
      );
    case 'remove_instruction_breakpoint':
      return manager.removeInstructionBreakpoint(
        str(d, 'instructionReference') as string,
        num(d, 'offset'),
        callOpts(d),
      );
    case 'data_breakpoint_info': {
      if (str(d, 'name') === undefined && num(d, 'variablesReference') === undefined) {
        throw new DebugToolError(
          'usage',
          'data_breakpoint_info requires at least one of name or variablesReference',
        );
      }
      return manager.dataBreakpointInfo(str(d, 'name'), num(d, 'variablesReference'), callOpts(d));
    }
    case 'set_data_breakpoint':
      return manager.setDataBreakpoint(
        str(d, 'dataId') as string,
        str(d, 'accessType') as 'read' | 'write' | 'readWrite' | undefined,
        str(d, 'condition'),
        callOpts(d),
      );
    case 'remove_data_breakpoint':
      return manager.removeDataBreakpoint(str(d, 'dataId') as string, callOpts(d));
    case 'continue':
      return manager.continue(num(d, 'threadId'), callOpts(d));
    case 'pause':
      return manager.pause(num(d, 'threadId'), callOpts(d));
    case 'step_over':
      return manager.stepOver(num(d, 'threadId'), callOpts(d));
    case 'step_in':
      return manager.stepIn(num(d, 'threadId'), callOpts(d));
    case 'step_out':
      return manager.stepOut(num(d, 'threadId'), callOpts(d));
    case 'stack_trace':
      return manager.stackTrace(num(d, 'threadId'), num(d, 'levels'), callOpts(d));
    case 'threads':
      return manager.threads(callOpts(d));
    case 'scopes':
      return manager.scopes(num(d, 'frameId'), callOpts(d));
    case 'variables':
      return manager.variables(
        num(d, 'variablesReference') as number,
        num(d, 'start'),
        num(d, 'count'),
        callOpts(d),
      );
    case 'evaluate':
      return manager.evaluate(
        str(d, 'expression') as string,
        num(d, 'frameId'),
        str(d, 'context') as 'repl' | 'watch' | 'hover' | 'clipboard' | 'variables' | undefined,
        callOpts(d),
      );
    case 'exception_info':
      return manager.exceptionInfo(num(d, 'threadId'), callOpts(d));
    case 'output':
      return manager.output(num(d, 'tail'), callOpts(d));
    case 'disassemble':
      return manager.disassemble(
        str(d, 'memoryReference') as string,
        num(d, 'instructionCount'),
        num(d, 'instructionOffset'),
        num(d, 'offset'),
        bool(d, 'resolveSymbols'),
        callOpts(d),
      );
    case 'read_memory':
      return manager.readMemory(str(d, 'memoryReference') as string, num(d, 'count'), num(d, 'offset'), callOpts(d));
    case 'write_memory':
      return manager.writeMemory(str(d, 'memoryReference') as string, str(d, 'data') as string, num(d, 'offset'), callOpts(d));
    case 'modules':
      return manager.modules(num(d, 'startModule'), num(d, 'moduleCount'), callOpts(d));
    case 'loaded_sources':
      return manager.loadedSources(callOpts(d));
    case 'custom_request':
      return manager.customRequest(str(d, 'command') as string, obj(d, 'arguments'), callOpts(d));
  }
}

// ── 渲染（api-contract §7：同源两份）────────────────────────────────────────

function renderSuccess(payload: unknown): CallToolResult {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function renderError(error: unknown): CallToolResult {
  const body = toToolErrorBody(error);
  const text = JSON.stringify(body);
  return {
    content: [{ type: 'text', text }],
    structuredContent: body as unknown as Record<string, unknown>,
    isError: true,
  };
}

async function handleCall(args: unknown, manager: SessionManager): Promise<CallToolResult> {
  try {
    const { action, data } = parseArgs(args);
    const payload = await dispatch(manager, action, data);
    return renderSuccess(payload);
  } catch (error) {
    return renderError(error);
  }
}

// ── 注册（底层 Server handler；stdout 只承载 MCP 帧）────────────────────────

export function registerDebugTool(server: McpServer, sessionManager: SessionManager): void {
  const s = server.server;
  s.registerCapabilities({ tools: {} });
  s.setRequestHandler(ListToolsRequestSchema, () => {
    const result: ListToolsResult = {
      tools: [{ name: 'debug', description: TOOL_DESCRIPTION, inputSchema: buildInputSchema() }],
    };
    return result;
  });
  s.setRequestHandler(CallToolRequestSchema, async (request) => handleCall(request.params.arguments, sessionManager));
}
