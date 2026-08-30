/**
 * 命令解析（DESIGN.md §4.2/§4.4 + §8.2 固化，api-contract §4.3 commandResolution 形状）。
 *
 * 解析链（由高到低）：`commandResolution.envVar` 环境变量直接覆盖（最高优先）>
 * `candidates[]` 依序探测（支持 `~` 与模板变量展开；`~` 展开是本模块职责，模板变量
 * 复用 template.ts 的 renderTemplate）> 回落 PATH 查找（which 语义，裸命令名可缓存）>
 * 全败 → adapter 类错误（E-A1，携带配置的 installHint）。
 *
 * 注：本模块的解析目标是"文件路径"（可能是可执行文件，也可能是脚本，如 js-debug 的
 * dapDebugServer.js）；解析结果作为 command 还是 serverPath 注入模板由
 * adapter-registry（Task 11）决定。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./log.js";
import { renderTemplate } from "./template.js";
import { adapterCommandError, DebugToolError } from "./errors.js";

/** commandResolution 配置形状（DESIGN.md §4.2） */
export interface AdapterCommandResolution {
  /** 环境变量名；命中（非空）时直接覆盖命令（最高优先） */
  envVar?: string;
  /** 依序候选路径；首个存在者中；支持 `~` 与模板变量展开 */
  candidates?: string[];
  /** 全败时携带的安装提示 */
  installHint?: string;
}

export interface ResolveCommandOptions {
  /** 适配器记录的 command 字段（默认可执行名，供 PATH 回落） */
  command: string;
  /** 可选 commandResolution 配置 */
  resolution?: AdapterCommandResolution;
  /** 会话工作目录（调用方已规范化） */
  cwd: string;
  /** 环境快照；${env:NAME} 展开与 envVar 覆盖均从此读取 */
  env?: Record<string, string | undefined>;
  /** ${npmRoot} 模板值 */
  npmRoot?: string;
  /** PATH 值；缺省 process.env.PATH。测试注入 */
  envPath?: string;
  /** debug 级输出解析过程与最终命令 */
  logger?: Logger;
}

export interface ResolveCommandResult {
  /** 解析出的最终命令（绝对路径优先；envVar 覆盖时可能为裸名） */
  command: string;
  /** 解析来源 */
  source: "envVar" | "candidate" | "path";
}

/** 裸命令名 PATH 查找缓存（key = envPath + name）；含分隔符的路径不缓存 */
const PATH_LOOKUP_CACHE = new Map<string, string | null>();

/**
 * 解析适配器命令。失败抛 `DebugToolError("adapter")`（E-A1）。
 * 宽容语义：candidates 中某候选的模板变量未定义（usage 类，如 ${env:NAME} 未设置）
 * 视为该候选未命中，继续探测下一个候选或回落 PATH——与 DESIGN §4.2 js-debug 内置
 * 记录（candidates[0] = ${env:JS_DEBUG_DAP_SERVER}）一致；envVar 显式通道保持严格，
 * 其值含未定义模板变量仍报错（用户显式指定不该静默回落）。
 */
export function resolveCommand(opts: ResolveCommandOptions): ResolveCommandResult {
  const env = opts.env ?? {};
  const resolution = opts.resolution;
  const logger = opts.logger;

  // 1. envVar 环境变量直接覆盖（最高优先；严格通道，含 fieldPath 定位）
  if (resolution?.envVar !== undefined) {
    const raw = env[resolution.envVar];
    if (raw !== undefined && raw.trim() !== "") {
      const command = expandCommandPath(raw.trim(), opts, "commandResolution.envVar");
      logger?.debug(`command resolved via envVar '${resolution.envVar}': ${command}`, {
        command,
        source: "envVar",
      });
      return { command, source: "envVar" };
    }
  }

  // 2. candidates 依序探测（首个存在的文件；候选级模板 usage 错误视为未命中）
  if (resolution?.candidates !== undefined && resolution.candidates.length > 0) {
    for (let i = 0; i < resolution.candidates.length; i++) {
      let expanded: string;
      try {
        expanded = expandCommandPath(
          resolution.candidates[i],
          opts,
          `commandResolution.candidates[${i}]`,
        );
      } catch (error) {
        if (error instanceof DebugToolError && error.code === "usage") continue;
        throw error;
      }
      if (isExistingFile(expanded)) {
        logger?.debug(`command resolved via candidate[${i}]: ${expanded}`, {
          command: expanded,
          source: "candidate",
        });
        return { command: expanded, source: "candidate" };
      }
    }
  }

  // 3. 回落 PATH 查找（which 语义）
  const found = findExecutable(opts.command, opts.envPath, opts.cwd);
  if (found !== null) {
    logger?.debug(`command resolved via PATH: ${found}`, { command: found, source: "path" });
    return { command: found, source: "path" };
  }

  // 4. 全败 → adapter 类错误（E-A1，携带 installHint）
  throw adapterCommandError({
    command: opts.command,
    ...(resolution?.installHint !== undefined ? { installHint: resolution.installHint } : {}),
    ...(resolution?.candidates !== undefined ? { attempted: resolution.candidates } : {}),
  });
}

/**
 * which 语义的 PATH 查找。含路径分隔符 → 直接按绝对/相对 cwd 路径检查可执行；
 * 裸命令名 → 遍历 PATH（缓存命中优先）。未命中返回 null。
 */
export function findExecutable(
  name: string,
  envPath?: string,
  cwd?: string,
): string | null {
  const pathValue = envPath ?? process.env.PATH ?? "";
  if (name.includes("/") || name.includes("\\")) {
    const target = path.isAbsolute(name) ? name : path.resolve(cwd ?? process.cwd(), name);
    return isExecutableFile(target) ? target : null;
  }
  const cacheKey = `${pathValue}\u0000${name}`;
  if (PATH_LOOKUP_CACHE.has(cacheKey)) return PATH_LOOKUP_CACHE.get(cacheKey) ?? null;
  let result: string | null = null;
  for (const dir of splitPath(pathValue)) {
    if (dir === "") continue;
    const target = path.join(dir, name);
    if (isExecutableFile(target)) {
      result = target;
      break;
    }
  }
  PATH_LOOKUP_CACHE.set(cacheKey, result);
  return result;
}

function expandCommandPath(
  value: string,
  opts: ResolveCommandOptions,
  fieldPath?: string,
): string {
  const expanded = renderTemplate(value, { env: opts.env, npmRoot: opts.npmRoot }, fieldPath);
  return expandTilde(expanded, opts.env?.HOME);
}

/** `~` / `~/` 前缀展开为 $HOME（`~` 不在模板变量集，属本模块职责） */
export function expandTilde(value: string, home?: string): string {
  if (value === "~") return home ?? value;
  if (value.startsWith("~/")) return (home ?? "") + value.slice(1);
  return value;
}

/** 存在且为文件（candidate 可能是脚本，仅要求存在） */
function isExistingFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 可执行判定（which 语义）：POSIX 用 X_OK；Windows 仅要求存在 */
function isExecutableFile(p: string): boolean {
  try {
    if (process.platform === "win32") {
      return fs.statSync(p).isFile();
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function splitPath(envPath: string): string[] {
  const sep = process.platform === "win32" ? ";" : ":";
  return envPath.split(sep);
}
