/**
 * 适配器注册表（DESIGN.md §4 固化，api-contract §4.3）——配置体系的核心。
 *
 * 职责：
 *   1. 三层配置 merge（内置 adapters/defaults.json < 用户级 < 项目级；对象深合并、数组替换）；
 *   2. 适配器记录 zod 校验（adapter-schema.ts，strict）；
 *   3. 模板展开（template.ts 引擎；${port}/${socketPath} 为延迟变量原样保留，由 transport 层
 *      spawn 前替换——Controller Ruling，其余变量正常展开，未知变量 → usage）；
 *   4. commandResolution 集成（command.ts 的 resolveCommand，勿重写）；
 *   5. 选择算法（DESIGN.md §4.4 单一路径）+ launchRules 求值（§4.2）。
 *
 * 选择/合并失败一律抛 `DebugToolError("usage")`（E-U3，api-contract §4.3）。
 * 内置 defaults.json 定位用 import.meta.url 相对上溯：src/core/*.ts 与 build 后 dist/core/*.js
 * 深度同为两级，包根 adapters/ 相对路径一致（../../adapters/defaults.json）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
  adaptersSchema,
  DEFAULT_SETTINGS,
  settingsSchema,
  type ParsedAdapterRecord,
  type ParsedLaunchRule,
  type ParsedSettings,
} from "./adapter-schema.js";
import {
  adapterSelectionError,
  attachConnectPortRequiredError,
  attachTargetError,
  DebugToolError,
  unknownAdapterError,
} from "./errors.js";
import { renderTemplate } from "./template.js";
import { findExecutable, resolveCommand } from "./command.js";
import type { Logger } from "./log.js";

// ── 契约类型（api-contract §3 归属本文件）─────────────────────────────

/** 全局设置（DESIGN.md §4.1 + 附录 A 默认值；详见 adapter-schema.DEFAULT_SETTINGS） */
export interface Settings {
  idleTimeoutMs: number;
  cleanupIntervalMs: number;
  terminatedRetentionMs: number;
  heartbeatIntervalMs: number;
  stopCaptureTimeoutMs: number;
  requestTimeoutMs: number;
  socketReadyTimeoutMs: number;
  maxOutputBytes: number;
  binaryPreference: string[];
  attachPreference: { withPort: string[]; withPid: string[] };
  allowRunInTerminal: boolean;
}

/** 解析后的适配器（最终可执行文件 + 模板展开后的参数） */
export interface ResolvedAdapter {
  name: string;
  transport: "stdio" | "socket" | "tcp";
  command: string;
  args: string[];
  acceptsDirectoryProgram: boolean;
  /** 适配器声明的环境叠加层（模板已渲染）；未声明时 undefined（spawn 语义 = 继承 MCP 环境） */
  env?: Record<string, string>;
}

export interface ResolveLaunchInput {
  program: string;
  cwd: string;
  adapter?: string;
  /** 目标命令行参数（附加到 launchArguments.args，可选扩展；契约 §4.3 未列但工具层需要） */
  args?: string[];
  /** 调用方显式 DAP 请求体覆盖（DESIGN §4.1：合并序中永远最高优先的一层） */
  dapArguments?: Record<string, unknown>;
}

export interface ResolveAttachInput {
  cwd: string;
  adapter?: string;
  pid?: number;
  port?: number;
  host?: string;
  /** 调用方显式 DAP 请求体覆盖（DESIGN §4.1：合并序中永远最高优先的一层） */
  dapArguments?: Record<string, unknown>;
}

export interface LaunchResolution {
  adapter: ResolvedAdapter;
  /** launchDefaults ⊕ launchRules 命中覆盖 ⊕ 显式参数（program/cwd/args）⊕ dapArguments 后的最终 launch arguments */
  launchArguments: Record<string, unknown>;
}

export interface AttachResolution {
  adapter: ResolvedAdapter;
  /** attach 会话的 adapter 侧连接：spawn（MCP 拉起）或 tcp（复连既有 DAP server，§4.4） */
  connection: { kind: "spawn" } | { kind: "tcp"; host: string; port: number };
  /** attachDefaults ⊕ pid/port/host 合成 ⊕ dapArguments 后的最终 attach arguments */
  attachArguments: Record<string, unknown>;
}

// ── 内部 ──────────────────────────────────────────────────────────────

/** 模板延迟变量：registry 渲染时原样保留（${port}/${socketPath}），由 transport 层 spawn 前替换 */
const DEFERRED_TEMPLATE_VARS: ReadonlySet<string> = new Set(["port", "socketPath"]);

/** 内置 defaults.json 相对本模块的定位（src/core/*.ts 与 dist/core/*.js 深度同为两级） */
const DEFAULT_DEFAULTS_PATH = fileURLToPath(new URL("../../adapters/defaults.json", import.meta.url));

interface MergedConfig {
  settings: ParsedSettings;
  adapters: Record<string, ParsedAdapterRecord>;
}

interface ConfigLayer {
  settings?: unknown;
  adapters?: Record<string, unknown>;
}

interface TemplateCtx {
  cwd: string;
  program?: string;
  env: Record<string, string | undefined>;
  npmRoot?: string;
  serverPath?: string;
}

export interface AdapterRegistryOptions {
  /** settings 基底（最低层；index.ts 应传 DEFAULT_SETTINGS 或 CLI 默认）；被用户/项目级配置覆盖 */
  settings: Settings;
  logger: Logger;
  loadProjectConfig: boolean;
  /** --config <path> 替代默认用户级路径 */
  userConfigPath?: string;
  /** 环境快照（构造时用于定位用户级配置；resolve 时用于 ${env:NAME} 展开） */
  env?: Record<string, string | undefined>;
  /** PATH 值（commandResolution 回落）；缺省 process.env.PATH */
  envPath?: string;
  /** ${npmRoot} 模板值（npm root -g 启动时缓存） */
  npmRoot?: string;
  /** 内置 defaults.json 路径覆盖（测试注入） */
  defaultsPath?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 对象深合并（数组替换）：两值均为普通对象时逐键递归，否则 override 整体替换
 * （DESIGN.md §4.1 "对象深合并、数组替换"）。
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      // `__proto__` 是 Object.prototype 的原型访问器，赋值会改写目标对象原型 → 过滤（M-1）
      if (key === '__proto__') continue;
      out[key] = deepMerge(out[key], override[key]);
    }
    return out;
  }
  return override;
}

/**
 * 配置分层合并：低优先级在前、高优先级在后，依次 deepMerge。
 * 独立纯函数便于测试（三层优先级与数组替换语义）。
 */
export function mergeConfigLayers(layers: Array<ConfigLayer | null | undefined>): {
  settings: unknown;
  adapters: Record<string, unknown>;
} {
  let settings: unknown = {};
  let adapters: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    settings = deepMerge(settings, layer.settings);
    adapters = deepMerge(adapters, layer.adapters) as Record<string, unknown>;
  }
  return { settings, adapters };
}

/** 默认用户级配置路径：${XDG_CONFIG_HOME:-~/.config}/debug-dap-mcp/config.json */
function userConfigPathFromEnv(env: Record<string, string | undefined>): string | null {
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg.trim() !== ""
      ? xdg
      : env.HOME !== undefined && env.HOME.trim() !== ""
        ? path.join(env.HOME, ".config")
        : null;
  if (!base) return null;
  return path.join(base, "debug-dap-mcp", "config.json");
}

function configInvalidError(
  scope: string,
  issues: Array<{ path?: PropertyKey[]; message?: string }>,
): never {
  const joined = issues
    .map((i) => `${(i.path ?? []).map(String).join(".")}: ${i.message ?? "invalid"}`)
    .join("; ");
  throw new DebugToolError("usage", `invalid adapter configuration (${scope}): ${joined}`, { issues });
}

function parseSettings(input: unknown): ParsedSettings {
  const result = settingsSchema.safeParse(input);
  if (result.success) return result.data;
  throw configInvalidError("settings", result.error.issues);
}

function parseAdapters(input: unknown): Record<string, ParsedAdapterRecord> {
  const result = adaptersSchema.safeParse(input);
  if (result.success) return result.data;
  throw configInvalidError("adapters", result.error.issues);
}

/** 读取并解析 JSONC 配置文件；文件不存在/不可读 → null */
function readConfigFile(filePath: string): ConfigLayer | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new DebugToolError("usage", `invalid JSONC in ${filePath}: ${printParseErrorCode(errors[0].error)}`);
  }
  if (!isPlainObject(parsed)) return null;
  return {
    ...(isPlainObject(parsed.settings) ? { settings: parsed.settings } : {}),
    ...(isPlainObject(parsed.adapters) ? { adapters: parsed.adapters } : {}),
  };
}

function loadDefaultsFile(defaultsPath: string): Record<string, unknown> {
  const layer = readConfigFile(defaultsPath);
  if (!layer || !isPlainObject(layer.adapters)) {
    throw new DebugToolError("usage", `invalid builtin adapter defaults: ${defaultsPath}`);
  }
  return layer.adapters;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** glob-like marker（如 "*.sln"）转正则；无 * 时直接路径存在检查（移植 lsp/config hasRootMarkers 语义） */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function hasMarkerInDir(dir: string, marker: string): boolean {
  if (!marker.includes("*")) {
    return fs.existsSync(path.join(dir, marker));
  }
  try {
    const entries = fs.readdirSync(dir);
    const re = globToRegExp(marker);
    return entries.some((e) => re.test(e));
  } catch {
    return false;
  }
}

/** program 祖先目录（含自身）是否含任一 rootMarker（DESIGN.md §4.4 路径 3） */
function hasRootMarker(program: string, programKind: "file" | "directory", markers: string[]): boolean {
  if (markers.length === 0) return false;
  let dir = programKind === "directory" ? program : path.dirname(program);
  while (true) {
    if (markers.some((m) => hasMarkerInDir(dir, m))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** launchRules 按序首个命中（programShape directory/file + extensions；DESIGN.md §4.2） */
function matchLaunchRules(
  rules: ParsedLaunchRule[],
  program: string,
  programKind: "file" | "directory",
): Record<string, unknown> {
  const ext = path.extname(program).toLowerCase();
  for (const rule of rules) {
    const { programShape, extensions } = rule.when;
    if (programShape === "directory") {
      if (programKind === "directory") return rule.defaults;
      continue;
    }
    if (programKind !== "file") continue;
    if (extensions !== undefined && extensions.length > 0 && !extensions.includes(ext)) continue;
    return rule.defaults;
  }
  return {};
}

/** 递归展开记录/数组中的字符串模板（${port}/${socketPath} 延迟保留，未知变量 → usage） */
function renderValue(value: unknown, ctx: TemplateCtx, fieldPath: string): unknown {
  if (typeof value === "string") {
    return renderTemplate(value, ctx, fieldPath, DEFERRED_TEMPLATE_VARS);
  }
  if (isPlainObject(value)) return renderRecord(value, ctx, fieldPath);
  if (Array.isArray(value)) return value.map((item, i) => renderValue(item, ctx, `${fieldPath}[${i}]`));
  return value;
}

function renderRecord(rec: Record<string, unknown> | undefined, ctx: TemplateCtx, fieldPath: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec ?? {})) {
    out[k] = renderValue(v, ctx, `${fieldPath}.${k}`);
  }
  return out;
}

/** 适配器模板是否引用 ${serverPath}（决定 commandResolution 解析结果注入 serverPath 还是 command） */
function recordUsesServerPath(record: ParsedAdapterRecord): boolean {
  return JSON.stringify([record.args, record.launchDefaults, record.attachDefaults]).includes("${serverPath}");
}

export class AdapterRegistry {
  readonly #logger: Logger;
  readonly #loadProjectConfig: boolean;
  readonly #env: Record<string, string | undefined>;
  readonly #envPath: string | undefined;
  readonly #npmRoot: string | undefined;
  readonly #userConfigPath: string | undefined;
  readonly #defaultsPath: string;
  readonly #base: MergedConfig;
  readonly #projectCache = new Map<string, MergedConfig>();

  constructor(options: AdapterRegistryOptions) {
    this.#logger = options.logger;
    this.#loadProjectConfig = options.loadProjectConfig;
    this.#env = options.env ?? {};
    this.#envPath = options.envPath;
    this.#npmRoot = options.npmRoot;
    this.#userConfigPath = options.userConfigPath;
    this.#defaultsPath = options.defaultsPath ?? DEFAULT_DEFAULTS_PATH;

    const builtin = loadDefaultsFile(this.#defaultsPath);
    const userPath = this.#userConfigPath ?? userConfigPathFromEnv(this.#env);
    const user = userPath ? readConfigFile(userPath) : null;
    const merged = mergeConfigLayers([
      { settings: options.settings ?? DEFAULT_SETTINGS, adapters: builtin },
      user,
    ]);
    this.#base = { settings: parseSettings(merged.settings), adapters: parseAdapters(merged.adapters) };
  }

  /** 最终 settings（内置 + 用户级合并；项目级依赖 resolve 的 cwd，不反映于此——见 report concerns） */
  get settings(): Settings {
    return this.#base.settings;
  }

  /** 选择算法（DESIGN.md §4.4 五路径：目录前置过滤 → 显式 → fileTypes → rootMarkers → binaryPreference → E-U3） */
  resolveLaunch(input: ResolveLaunchInput): LaunchResolution {
    const cwd = path.resolve(input.cwd);
    const program = path.resolve(cwd, input.program);
    const merged = this.#mergeForCwd(cwd);
    const programKind: "file" | "directory" = isDirectory(program) ? "directory" : "file";
    const ctx = this.#makeCtx(cwd, program, merged);
    const failures: Array<{ name: string; reason: string }> = [];

    const allNames = Object.keys(merged.adapters);
    // 路径 0：目录前置过滤（仅 acceptsDirectoryProgram）
    const candidates =
      programKind === "directory"
        ? allNames.filter((n) => merged.adapters[n].acceptsDirectoryProgram === true)
        : allNames;

    // 路径 1：显式 adapter
    if (input.adapter !== undefined) {
      const record = merged.adapters[input.adapter];
      if (!record) throw unknownAdapterError(input.adapter, allNames);
      // 目录程序仅接受 acceptsDirectoryProgram 适配器（契约 §5.1：目录仅此类适配器）
      if (programKind === "directory" && record.acceptsDirectoryProgram !== true) {
        throw adapterSelectionError([{ name: input.adapter, reason: "directory program not accepted" }]);
      }
      const resolved = this.#tryResolveAdapter(input.adapter, record, ctx);
      if (!resolved.ok) throw adapterSelectionError([{ name: input.adapter, reason: resolved.reason }]);
      return this.#buildLaunch(input, program, cwd, programKind, record, resolved);
    }

    const ext = path.extname(program).toLowerCase();

    // 路径 2：扩展名 ∈ fileTypes
    if (ext !== "") {
      const matched = candidates.filter((n) => (merged.adapters[n].fileTypes ?? []).includes(ext));
      if (matched.length > 0) {
        const chosen = this.#pickAvailable(this.#sortForLaunch(matched, program, programKind, merged), merged, ctx, failures);
        if (chosen) return this.#buildLaunch(input, program, cwd, programKind, merged.adapters[chosen.name], chosen);
      }
    }

    // 路径 3：祖先目录含 rootMarkers
    const rootMatched = candidates.filter((n) => hasRootMarker(program, programKind, merged.adapters[n].rootMarkers ?? []));
    if (rootMatched.length > 0) {
      const chosen = this.#pickAvailable(this.#sortForLaunch(rootMatched, program, programKind, merged), merged, ctx, failures);
      if (chosen) return this.#buildLaunch(input, program, cwd, programKind, merged.adapters[chosen.name], chosen);
    }

    // 路径 4：无扩展名文件 → binaryPreference 顺序首个可用
    if (ext === "") {
      const ordered = merged.settings.binaryPreference.filter((n) => candidates.includes(n));
      const chosen = this.#pickAvailable(this.#sortForLaunch(ordered, program, programKind, merged), merged, ctx, failures);
      if (chosen) return this.#buildLaunch(input, program, cwd, programKind, merged.adapters[chosen.name], chosen);
    }

    // 兜底：无扩展名文件/目录程序，候选集内排序取首个可用（移植源 directory/extensionless 分支语义；
    // 有扩展名的文件不匹配 fileTypes/rootMarkers 时仍按 DESIGN §4.4 视为全败）
    if (ext === "") {
      const fallback = this.#pickAvailable(this.#sortForLaunch(candidates, program, programKind, merged), merged, ctx, failures);
      if (fallback) return this.#buildLaunch(input, program, cwd, programKind, merged.adapters[fallback.name], fallback);
    }

    // 路径 5：全败 → E-U3（消息含各候选未中原因）
    const effectiveFailures =
      failures.length > 0
        ? failures
        : allNames.map((n) => ({
            name: n,
            reason:
              programKind === "directory" && merged.adapters[n].acceptsDirectoryProgram !== true
                ? "directory program not accepted"
                : "no selection rule matched",
          }));
    throw adapterSelectionError(effectiveFailures);
  }

  /** attach 选择（DESIGN.md §4.4 / api-contract §4.3 注记 2：显式 > withPort > withPid > 候选首个可用） */
  resolveAttach(input: ResolveAttachInput): AttachResolution {
    const hasPid = input.pid !== undefined;
    const hasPort = input.port !== undefined;
    if (hasPid === hasPort) throw attachTargetError(); // 皆有或皆无
    const cwd = path.resolve(input.cwd);
    const merged = this.#mergeForCwd(cwd);
    const ctx = this.#makeCtx(cwd, undefined, merged);
    const failures: Array<{ name: string; reason: string }> = [];

    if (input.adapter !== undefined) {
      const record = merged.adapters[input.adapter];
      if (!record) throw unknownAdapterError(input.adapter, Object.keys(merged.adapters));
      const resolved = this.#tryResolveAdapter(input.adapter, record, ctx);
      if (!resolved.ok) throw adapterSelectionError([{ name: input.adapter, reason: resolved.reason }]);
      return this.#buildAttach(input, record, resolved);
    }

    const prefs = hasPort ? merged.settings.attachPreference.withPort : merged.settings.attachPreference.withPid;
    const ordered = prefs.filter((n) => n in merged.adapters);
    const chosen = this.#pickAvailable(ordered, merged, ctx, failures);
    if (chosen) return this.#buildAttach(input, merged.adapters[chosen.name], chosen);

    const fallbackNames = Object.keys(merged.adapters).filter((n) => !ordered.includes(n));
    const fallback = this.#pickAvailable(fallbackNames, merged, ctx, failures);
    if (fallback) return this.#buildAttach(input, merged.adapters[fallback.name], fallback);

    throw adapterSelectionError(failures.length > 0 ? failures : [{ name: "any", reason: "no adapter available" }]);
  }

  // ── 内部 ─────────────────────────────────────────────────────────

  #makeCtx(cwd: string, program: string | undefined, merged: MergedConfig): TemplateCtx {
    return {
      cwd,
      ...(program !== undefined ? { program } : {}),
      env: this.#env,
      ...(this.#npmRoot !== undefined ? { npmRoot: this.#npmRoot } : {}),
    };
  }

  #mergeForCwd(cwd: string): MergedConfig {
    if (!this.#loadProjectConfig) return this.#base;
    const cached = this.#projectCache.get(cwd);
    if (cached) return cached;
    const projPath = path.join(cwd, ".debug-dap-mcp.json");
    if (!fs.existsSync(projPath)) {
      this.#projectCache.set(cwd, this.#base);
      return this.#base;
    }
    const proj = readConfigFile(projPath);
    const merged = mergeConfigLayers([{ settings: this.#base.settings, adapters: this.#base.adapters }, proj]);
    const result: MergedConfig = { settings: parseSettings(merged.settings), adapters: parseAdapters(merged.adapters) };
    this.#projectCache.set(cwd, result);
    return result;
  }

  /** 解析适配器命令（commandResolution 集成 + command 模板展开）；usage 配置错误直接上抛，adapter 不可用折为 reason */
  #resolveCommandFor(name: string, record: ParsedAdapterRecord, ctx: TemplateCtx): string {
    const commandField = renderTemplate(record.command, ctx, `adapters.${name}.command`, DEFERRED_TEMPLATE_VARS);
    if (record.commandResolution) {
      const resolved = resolveCommand({
        command: commandField,
        resolution: record.commandResolution,
        cwd: ctx.cwd,
        env: ctx.env,
        ...(this.#npmRoot !== undefined ? { npmRoot: this.#npmRoot } : {}),
        envPath: this.#envPath,
        logger: this.#logger,
      });
      if (recordUsesServerPath(record)) {
        ctx.serverPath = resolved.command; // 服务文件注入模板（js-debug 形态）
        const fallback = findExecutable(commandField, this.#envPath, ctx.cwd) ?? process.execPath;
        return fallback;
      }
      return resolved.command;
    }
    const r = resolveCommand({
      command: commandField,
      cwd: ctx.cwd,
      env: ctx.env,
      ...(this.#npmRoot !== undefined ? { npmRoot: this.#npmRoot } : {}),
      envPath: this.#envPath,
      logger: this.#logger,
    });
    return r.command;
  }

  #tryResolveAdapter(
    name: string,
    record: ParsedAdapterRecord,
    ctx: TemplateCtx,
  ): { ok: true; adapter: ResolvedAdapter; ctx: TemplateCtx } | { ok: false; reason: string } {
    const attemptCtx: TemplateCtx = { ...ctx };
    try {
      const command = this.#resolveCommandFor(name, record, attemptCtx);
      const args = (record.args ?? []).map((a, i) =>
        renderTemplate(a, attemptCtx, `adapters.${name}.args[${i}]`, DEFERRED_TEMPLATE_VARS),
      );
      const env = record.env
        ? Object.fromEntries(
            Object.entries(record.env).map(([k, v]) => [
              k,
              renderTemplate(v, attemptCtx, `adapters.${name}.env.${k}`, DEFERRED_TEMPLATE_VARS),
            ]),
          )
        : undefined;
      return {
        ok: true,
        adapter: {
          name,
          transport: record.transport,
          command,
          args,
          acceptsDirectoryProgram: record.acceptsDirectoryProgram === true,
          ...(env !== undefined ? { env } : {}),
        },
        ctx: attemptCtx,
      };
    } catch (e) {
      if (e instanceof DebugToolError && e.code === "usage") throw e; // 模板/配置错误：直接上抛而非当作不可用
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 依序取首个可用的候选；不可用者记入 failures（供全败 E-U3）。基于累积 failures
   *  推导已失败集合，跨多次 #pickAvailable 调用（如 binaryPreference 后兜底全集）去重，
   *  保证同一候选在全败消息中只出现一次。 */
  #pickAvailable(
    names: string[],
    merged: MergedConfig,
    ctx: TemplateCtx,
    failures: Array<{ name: string; reason: string }>,
  ): { name: string; adapter: ResolvedAdapter; ctx: TemplateCtx } | null {
    const failed = new Set(failures.map((f) => f.name));
    for (const name of names) {
      if (failed.has(name)) continue;
      const r = this.#tryResolveAdapter(name, merged.adapters[name], ctx);
      if (r.ok) return { name, adapter: r.adapter, ctx: r.ctx };
      failures.push({ name, reason: r.reason });
      failed.add(name);
    }
    return null;
  }

  /** launch 候选排序：rootMarker 命中优先 → binaryPreference 顺序 → 名字序（移植 sortAdaptersForLaunch 收敛） */
  #sortForLaunch(names: string[], program: string, programKind: "file" | "directory", merged: MergedConfig): string[] {
    const pref = merged.settings.binaryPreference;
    return [...names].sort((a, b) => {
      const aRoot = hasRootMarker(program, programKind, merged.adapters[a].rootMarkers ?? []) ? 0 : 1;
      const bRoot = hasRootMarker(program, programKind, merged.adapters[b].rootMarkers ?? []) ? 0 : 1;
      if (aRoot !== bRoot) return aRoot - bRoot;
      const ai = pref.indexOf(a);
      const bi = pref.indexOf(b);
      const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      if (ar !== br) return ar - br;
      return a.localeCompare(b);
    });
  }

  #buildLaunch(
    input: ResolveLaunchInput,
    program: string,
    cwd: string,
    programKind: "file" | "directory",
    record: ParsedAdapterRecord,
    resolved: { adapter: ResolvedAdapter; ctx: TemplateCtx },
  ): LaunchResolution {
    const launchDefaults = renderRecord(record.launchDefaults, resolved.ctx, `adapters.${resolved.adapter.name}.launchDefaults`);
    const ruleDefaults = matchLaunchRules(record.launchRules ?? [], program, programKind);
    const ruleDefaultsExpanded = renderRecord(ruleDefaults, resolved.ctx, `adapters.${resolved.adapter.name}.launchRules`);
    const launchArguments: Record<string, unknown> = {
      ...launchDefaults,
      ...ruleDefaultsExpanded,
      program,
      cwd,
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.dapArguments ?? {}),
    };
    return { adapter: resolved.adapter, launchArguments };
  }

  #buildAttach(input: ResolveAttachInput, record: ParsedAdapterRecord, resolved: { adapter: ResolvedAdapter; ctx: TemplateCtx }): AttachResolution {
    const attachDefaults = renderRecord(record.attachDefaults, resolved.ctx, `adapters.${resolved.adapter.name}.attachDefaults`);
    // connect 型（§4.4）：port = 既有 DAP server 端点，MCP 复连不 spawn；请求体不含结构化连接字段
    if (record.attachConnection === "connect") {
      if (input.port === undefined) throw attachConnectPortRequiredError();
      return {
        adapter: resolved.adapter,
        connection: { kind: "tcp", host: input.host ?? "127.0.0.1", port: input.port },
        attachArguments: { ...attachDefaults, ...(input.dapArguments ?? {}) },
      };
    }
    const attachArguments: Record<string, unknown> =
      input.port !== undefined
        ? { ...attachDefaults, port: input.port, host: input.host ?? "127.0.0.1" }
        : { ...attachDefaults, [record.pidArgument ?? "pid"]: input.pid! };
    return {
      adapter: resolved.adapter,
      connection: { kind: "spawn" },
      attachArguments: { ...attachArguments, ...(input.dapArguments ?? {}) },
    };
  }
}
