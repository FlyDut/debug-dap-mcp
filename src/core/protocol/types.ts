/**
 * DAP 协议层类型（移植自 oh-my-pi `src/dap/types.ts`）。
 * 命名差异说明（api-contract §3 权威）：
 *   - `DapSessionStatus` → `SessionStatus`；`DapStopLocation` → `CurrentStop`；`DapSessionSummary` → `SessionSummary`；
 *   - DAP 透传别名去 `Dap` 前缀：`Source`/`Thread`/`StackFrame`/`Scope`/`Variable`/`Module`/`DisassembledInstruction`/
 *     `InitializeArguments`/`EvaluateResult`/`DataBreakpointInfoResponse`；`DapCapabilities` 保留原名；
 *   - 断点记录改名为 `SourceBreakpointRecord`/`FunctionBreakpointRecord`/`InstructionBreakpointRecord`/
 *     `DataBreakpointRecord`，其中前两者按 api-contract §3.5 补 `hitCondition?`；
 *   - 新增 `EvaluateContext`、`Outcome`（§3.4）、`CLIENT_INITIALIZE_ARGUMENTS_BASE`（§4.1）；
 *   - 删除 `DapClientState`（依赖移植宿主 `ptree`，本项目无该依赖且 client 层契约重设计，§4.2）；
 *     删除 `DapContinueOutcome`（语义被 `Outcome` 取代）。
 */

export type DapMessage = DapRequestMessage | DapResponseMessage | DapEventMessage;
export type SessionStatus = "launching" | "configuring" | "stopped" | "running" | "terminated";

export interface DapProtocolMessage {
  seq: number;
  type: "request" | "response" | "event";
}

export interface DapRequestMessage extends DapProtocolMessage {
  type: "request";
  command: string;
  arguments?: unknown;
}

export interface DapResponseMessage extends DapProtocolMessage {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DapEventMessage extends DapProtocolMessage {
  type: "event";
  event: string;
  body?: unknown;
}

export interface DapErrorBody {
  id?: number;
  format: string;
  variables?: Record<string, string>;
  showUser?: boolean;
  sendTelemetry?: boolean;
  url?: string;
  urlLabel?: string;
}

export interface Source {
  name?: string;
  path?: string;
  sourceReference?: number;
  presentationHint?: "normal" | "emphasize" | "deemphasize";
  origin?: string;
  adapterData?: unknown;
}

export interface DapBreakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: Source;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  instructionReference?: string;
  offset?: number;
}

export interface DapSourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface DapFunctionBreakpoint {
  name: string;
  condition?: string;
  hitCondition?: string;
}

export interface InitializeArguments {
  clientID?: string;
  clientName?: string;
  adapterID?: string;
  locale?: string;
  linesStartAt1?: boolean;
  columnsStartAt1?: boolean;
  pathFormat?: "path" | "uri";
  supportsVariableType?: boolean;
  supportsVariablePaging?: boolean;
  supportsRunInTerminalRequest?: boolean;
  supportsStartDebuggingRequest?: boolean;
  supportsMemoryReferences?: boolean;
  supportsProgressReporting?: boolean;
  supportsInvalidatedEvent?: boolean;
  supportsArgsCanBeInterpretedByShell?: boolean;
}

export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsTerminateRequest?: boolean;
  supportsTerminateThreadsRequest?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsSetVariable?: boolean;
  supportsRestartRequest?: boolean;
  supportsCompletionsRequest?: boolean;
  supportsLogPoints?: boolean;
  supportsDisassembleRequest?: boolean;
  supportsReadMemoryRequest?: boolean;
  supportsWriteMemoryRequest?: boolean;
  supportsModulesRequest?: boolean;
  supportsLoadedSourcesRequest?: boolean;
  supportsExceptionInfoRequest?: boolean;
  supportsInstructionBreakpoints?: boolean;
  supportsDataBreakpoints?: boolean;
  supportsSteppingGranularity?: boolean;
  supportsClipboardContext?: boolean;
  [key: string]: unknown;
}

export interface DapLaunchArguments {
  program: string;
  args?: string[];
  cwd?: string;
  stopOnEntry?: boolean;
  stopAtBeginningOfMainSubprogram?: boolean;
  request?: "launch";
  [key: string]: unknown;
}

export interface DapAttachArguments {
  pid?: number;
  processId?: number;
  port?: number;
  host?: string;
  cwd?: string;
  request?: "attach";
  [key: string]: unknown;
}

export interface DapConfigurationDoneArguments {
  threadId?: number;
}

export interface DapSetBreakpointsArguments {
  source: Source;
  breakpoints: DapSourceBreakpoint[];
  sourceModified?: boolean;
}

export interface DapSetBreakpointsResponse {
  breakpoints: DapBreakpoint[];
}

export interface DapSetFunctionBreakpointsArguments {
  breakpoints: DapFunctionBreakpoint[];
}

export interface DapSetFunctionBreakpointsResponse {
  breakpoints: DapBreakpoint[];
}

export interface DapInstructionBreakpoint {
  instructionReference: string;
  offset?: number;
  condition?: string;
  hitCondition?: string;
}

export interface DapSetInstructionBreakpointsArguments {
  breakpoints: DapInstructionBreakpoint[];
}

export interface DapDataBreakpointInfoArguments {
  variablesReference?: number;
  name: string;
  frameId?: number;
}

export interface DataBreakpointInfoResponse {
  dataId: string | null;
  description: string;
  accessTypes?: Array<"read" | "write" | "readWrite">;
  canPersist?: boolean;
}

export interface DapDataBreakpoint {
  dataId: string;
  accessType?: "read" | "write" | "readWrite";
  condition?: string;
  hitCondition?: string;
}

export interface DapSetDataBreakpointsArguments {
  breakpoints: DapDataBreakpoint[];
}

export interface DapContinueArguments {
  threadId: number;
  singleThread?: boolean;
}

export interface DapContinueResponse {
  allThreadsContinued?: boolean;
}

export interface DapPauseArguments {
  threadId: number;
}

export interface DapStepArguments {
  threadId: number;
  singleThread?: boolean;
  granularity?: "statement" | "line" | "instruction";
}

export interface DapTerminateArguments {
  restart?: boolean;
}

export interface DapDisconnectArguments {
  restart?: boolean;
  terminateDebuggee?: boolean;
  suspendDebuggee?: boolean;
}

export interface DapStackTraceArguments {
  threadId: number;
  startFrame?: number;
  levels?: number;
  format?: Record<string, unknown>;
}

export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  instructionPointerReference?: string;
  moduleId?: number | string;
  presentationHint?: "normal" | "label" | "subtle";
}

export interface DapStackTraceResponse {
  stackFrames: StackFrame[];
  totalFrames?: number;
}

export interface DapScopesArguments {
  frameId: number;
}

export interface Scope {
  name: string;
  presentationHint?: "arguments" | "locals" | "registers" | string;
  variablesReference: number;
  expensive: boolean;
  source?: Source;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface DapScopesResponse {
  scopes: Scope[];
}

export interface DapVariablesArguments {
  variablesReference: number;
  filter?: "indexed" | "named";
  start?: number;
  count?: number;
  format?: Record<string, unknown>;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  presentationHint?: {
    kind?: string;
    attributes?: string[];
    visibility?: string;
    lazy?: boolean;
  };
  evaluateName?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
}

export interface DapVariablesResponse {
  variables: Variable[];
}

export interface DapDisassembleArguments {
  memoryReference: string;
  offset?: number;
  instructionOffset?: number;
  instructionCount: number;
  resolveSymbols?: boolean;
}

export interface DisassembledInstruction {
  address: string;
  instructionBytes?: string;
  instruction: string;
  symbol?: string;
  location?: Source;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface DapDisassembleResponse {
  instructions: DisassembledInstruction[];
}

export interface DapReadMemoryArguments {
  memoryReference: string;
  offset?: number;
  count: number;
}

export interface DapReadMemoryResponse {
  address: string;
  unreadableBytes?: number;
  data?: string;
}

export interface DapWriteMemoryArguments {
  memoryReference: string;
  offset?: number;
  data: string;
  allowPartial?: boolean;
}

export interface DapWriteMemoryResponse {
  offset?: number;
  bytesWritten?: number;
}

export interface Module {
  id: number | string;
  name: string;
  path?: string;
  isOptimized?: boolean;
  isUserCode?: boolean;
  version?: string;
  symbolStatus?: string;
  symbolFilePath?: string;
  dateTimeStamp?: string;
  addressRange?: string;
}

export interface DapModulesArguments {
  startModule?: number;
  moduleCount?: number;
}

export interface DapModulesResponse {
  modules: Module[];
  totalModules?: number;
}

export interface DapLoadedSourcesResponse {
  sources: Source[];
}

export type EvaluateContext = "watch" | "repl" | "hover" | "clipboard" | "variables";

export interface DapEvaluateArguments {
  expression: string;
  frameId?: number;
  context?: EvaluateContext;
  format?: Record<string, unknown>;
}

export interface EvaluateResult {
  result: string;
  type?: string;
  presentationHint?: {
    kind?: string;
    attributes?: string[];
    visibility?: string;
    lazy?: boolean;
  };
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
}

export interface Thread {
  id: number;
  name: string;
}

export interface DapThreadsResponse {
  threads: Thread[];
}

export interface DapOutputEventBody {
  category?: "console" | "important" | "stdout" | "stderr" | "telemetry" | string;
  output: string;
  group?: "start" | "startCollapsed" | "end";
  variablesReference?: number;
  source?: Source;
  line?: number;
  column?: number;
  data?: unknown;
}

export interface DapStoppedEventBody {
  reason: string;
  description?: string;
  threadId?: number;
  preserveFocusHint?: boolean;
  text?: string;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
}

export interface DapContinuedEventBody {
  threadId: number;
  allThreadsContinued?: boolean;
}

export interface DapExitedEventBody {
  exitCode?: number;
}

export interface DapTerminatedEventBody {
  restart?: boolean | Record<string, unknown>;
}

export interface DapInitializedEventBody {}

export interface DapRunInTerminalArguments {
  kind?: "integrated" | "external";
  title?: string;
  cwd?: string;
  args: string[];
  env?: Record<string, string | null>;
}

export interface DapRunInTerminalResponse {
  processId?: number;
  shellProcessId?: number;
}

export interface DapStartDebuggingArguments {
  request: "launch" | "attach";
  configuration: Record<string, unknown>;
}

export interface DapPendingRequest {
  resolve: (body: unknown) => void;
  reject: (error: Error) => void;
  command: string;
}

// ── api-contract §3.5 断点记录（verified 回传）──

export interface SourceBreakpointRecord {
  id?: number;
  verified: boolean;
  line: number;
  condition?: string;
  hitCondition?: string;
  message?: string;
}

export interface FunctionBreakpointRecord {
  id?: number;
  verified: boolean;
  name: string;
  condition?: string;
  hitCondition?: string;
  message?: string;
}

export interface InstructionBreakpointRecord {
  id?: number;
  verified: boolean;
  instructionReference: string;
  offset?: number;
  condition?: string;
  hitCondition?: string;
  message?: string;
}

export interface DataBreakpointRecord {
  id?: number;
  verified: boolean;
  dataId: string;
  accessType?: "read" | "write" | "readWrite";
  condition?: string;
  hitCondition?: string;
  message?: string;
}

// ── api-contract §3.2 CurrentStop（stop 时缓存的定位信息）──

export interface CurrentStop {
  threadId?: number;
  frameId?: number;
  reason?: string;
  description?: string;
  text?: string;
  frameName?: string;
  instructionPointerReference?: string;
  source?: Source;
  line?: number;
  column?: number;
}

// ── api-contract §3.3 SessionSummary（所有返回的统一载体）──

export interface SessionSummary {
  id: string;
  adapter: string;
  cwd: string;
  program?: string;
  status: SessionStatus;
  launchedAt: string;
  lastUsedAt: string;
  threadId?: number;
  frameId?: number;
  stopReason?: string;
  stopDescription?: string;
  frameName?: string;
  instructionPointerReference?: string;
  source?: Source;
  line?: number;
  column?: number;
  breakpointFiles: number;
  breakpointCount: number;
  functionBreakpointCount: number;
  outputBytes: number;
  outputTruncated: boolean;
  exitCode?: number;
  needsConfigurationDone: boolean;
  parentSessionId?: string;
  childSessionIds?: string[];
}

// ── api-contract §3.4 Outcome（流控族三态）──

export interface Outcome {
  outcome: "stopped" | "terminated" | "running";
  snapshot: SessionSummary;
}

// ── api-contract §4.1 常量（client-side declaration constants）──

// ── api-contract §4.1 常量（等待窗默认与 clamp 边界；clamp 由 MCP 层执行，本层消费）──

/** 等待窗默认（§2；缺省 timeout） */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** clamp 下限 */
export const TIMEOUT_CLAMP_MIN_MS = 5_000;
/** clamp 上限 */
export const TIMEOUT_CLAMP_MAX_MS = 300_000;

/** DESIGNED VALUES — initialize 的适配器无关参数；adapterID 在每次 initialize 时按适配器名填充 */
export const CLIENT_INITIALIZE_ARGUMENTS_BASE = {
  clientID: "debug-dap-mcp",
  clientName: "debug-dap-mcp",
  locale: "en-US",
  linesStartAt1: true,
  columnsStartAt1: true,
  pathFormat: "path",
  supportsRunInTerminalRequest: true,
  supportsStartDebuggingRequest: true,
  supportsMemoryReferences: true,
  supportsVariableType: true,
  supportsInvalidatedEvent: true,
} as const;
