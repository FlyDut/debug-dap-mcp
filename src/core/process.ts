/**
 * 进程管理（DESIGN.md §8.2，移植 oh-my-pi ptree/组信号逻辑到 node:child_process）。
 *
 * - spawnProcess：`child_process.spawn({ detached: true, shell: false })` + 非交互环境，
 *   使适配器进程树成为独立进程组（setsid）、无控制终端，防止 SIGTTIN；
 * - killProcessTree：POSIX `process.kill(-pgid)`（组信号，SIGTERM→宽限→SIGKILL 升级），
 *   Windows `taskkill /T /PID`（运行时分支，不经 POSIX 路径执行）；
 * - NON_INTERACTIVE_ENV / buildSpawnEnv：去 TERM/PS1 等交互变量并注入防交互固定值，
 *   防适配器交互行为/SIGTTIN；
 * - startOrphanWatcher：孤儿轮询兜底（父进程退出后，周期核查子进程存活并强杀；周期可注入）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import type { Logger } from "./log.js";

/** 非交互环境固定键值（自 oh-my-pi NON_INTERACTIVE_ENV 精简移植；不含 TERM/PS1） */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  // 禁用分页器，避免命令阻塞在交互视图
  PAGER: "cat",
  GIT_PAGER: "cat",
  MANPAGER: "cat",
  SYSTEMD_PAGER: "cat",
  LESS: "FRX",
  // 禁用终端特性/着色/缓冲
  NO_COLOR: "1",
  PYTHONUNBUFFERED: "1",
  // 禁用编辑器与终端凭据提示
  GIT_EDITOR: "true",
  VISUAL: "true",
  EDITOR: "true",
  GIT_TERMINAL_PROMPT: "0",
  CI: "true",
  AGENT: "1",
  // 包管理器无人值守默认
  npm_config_yes: "true",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_progress: "false",
  // 跨语言/工具链非交互默认
  CARGO_TERM_PROGRESS_WHEN: "never",
  DEBIAN_FRONTEND: "noninteractive",
  PIP_NO_INPUT: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  TF_INPUT: "0",
  TF_IN_AUTOMATION: "1",
  GH_PROMPT_DISABLED: "1",
  COMPOSER_NO_INTERACTION: "1",
};

/** 从子进程环境删除的交互 shell 变量（TERM 会触发适配器 TUI/清屏与 SIGTTIN） */
export const INTERACTIVE_STRIP_KEYS: readonly string[] = ["TERM", "PS1", "PS2", "PS3", "PS4"];

/**
 * 构造子进程环境：base（缺省 process.env）删除 TERM/PS1 等交互变量后，
 * 再叠加 NON_INTERACTIVE_ENV 固定值（固定值优先）。
 */
export function buildSpawnEnv(base?: Record<string, string | undefined>): Record<string, string> {
  const source = base ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (INTERACTIVE_STRIP_KEYS.includes(key)) continue;
    env[key] = value;
  }
  return { ...env, ...NON_INTERACTIVE_ENV };
}

export interface SpawnProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  /** 环境快照；缺省 process.env（经 buildSpawnEnv 处理） */
  env?: Record<string, string | undefined>;
  logger?: Logger;
}

export interface SpawnedProcess {
  child: ChildProcess;
  pid: number;
  /** 退出结算：exit code（signal 终止时为 null）；spawn 失败（如 ENOENT）也结算 null */
  exited: Promise<number | null>;
  /** 杀整棵进程树（幂等） */
  killTree(): Promise<void>;
}

/** 派生适配器进程：detached 建组、shell:false 不经 shell、非交互环境 */
export function spawnProcess(opts: SpawnProcessOptions): SpawnedProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: buildSpawnEnv(opts.env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    shell: false,
  });
  opts.logger?.debug(`spawn adapter: ${opts.command} ${opts.args.join(" ")} (pid ${child.pid ?? "?"})`, {
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
  });
  const pid = child.pid ?? 0;
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
  const killTree = (): Promise<void> => killProcessTree(pid, { logger: opts.logger });
  return { child, pid, exited, killTree };
}

export interface KillProcessTreeOptions {
  /** 首信号（默认 SIGTERM，组信号） */
  signal?: NodeJS.Signals;
  /** 宽限后升级信号（默认 SIGKILL，组信号） */
  killSignal?: NodeJS.Signals;
  /** SIGTERM 等待宽限（ms）；孤儿轮询场景传 0 直接 SIGKILL */
  graceMs?: number;
  /** 平台注入（默认 process.platform）；测试无需模拟 Windows 分支 */
  platform?: NodeJS.Platform;
  logger?: Logger;
}

/** 进程树 kill。POSIX 走 process.kill(-pgid)，Windows 走 taskkill /T /PID（运行时分支隔离）。 */
export async function killProcessTree(
  pid: number,
  opts: KillProcessTreeOptions = {},
): Promise<void> {
  if (pid <= 0) return;
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    await killProcessTreeWindows(pid);
    return;
  }
  await killProcessTreePosix(pid, opts);
}

/** POSIX：组信号 SIGTERM → 等待宽限 → 组信号 SIGKILL 升级 */
async function killProcessTreePosix(pid: number, opts: KillProcessTreeOptions): Promise<void> {
  const graceMs = opts.graceMs ?? 2000;
  signalGroup(pid, opts.signal ?? "SIGTERM");
  if (await waitGone(pid, graceMs)) return;
  signalGroup(pid, opts.killSignal ?? "SIGKILL");
  await waitGone(pid, 500);
}

/**
 * 向整个进程组发信号（detached 会话首领的负 pid 约定）。ESRCH = 组已灭，视为成功；
 * 其他失败（如 EPERM）回落直接信号首领进程。
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) return;
    // 回落直接首领
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* 已灭 */
  }
}

/**
 * 轮询等待进程组整体消失（组内任一存活即未全灭），最多 ms 毫秒。
 * 以 `process.kill(-pid, 0)` 组存活探测而非仅查首领：首领响应 SIGTERM 退出而某后代
 * 忽略 SIGTERM 时，组仍未灭，必须等满宽限走 SIGKILL 升级，否则后代泄漏。
 */
async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true;
    await sleep(20);
  }
  return false;
}

/** 进程组存活探测（信号 0 组发送）：ESRCH = 组已灭；EPERM 等视为仍存活（保守） */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) return false;
    return true;
  }
}

/** Windows：taskkill /PID <pid> /T /F；taskkill 不可用时回落直接终止首领 */
async function killProcessTreeWindows(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    killer.on("exit", () => done());
    killer.on("error", () => done());
  });
  try {
    process.kill(pid);
  } catch {
    /* 已灭 */
  }
}

export interface OrphanWatcherOptions {
  /** 轮询周期（ms）；测试可注入极小值加速 */
  intervalMs?: number;
  /** 孤儿判定；缺省 POSIX 读 /proc/<pid>/stat 的 ppid 是否为当前进程 */
  isOrphaned?: (pid: number) => boolean;
  logger?: Logger;
}

export interface OrphanWatcher {
  /** 停止轮询（幂等） */
  stop(): void;
}

/**
 * 孤儿轮询兜底：父进程（MCP server）退出后，detached 适配器被 init 收养，
 * 本监视器周期核查其是否沦为孤儿并强杀整棵进程树。
 */
export function startOrphanWatcher(pid: number, opts: OrphanWatcherOptions = {}): OrphanWatcher {
  const intervalMs = opts.intervalMs ?? 30_000;
  const isOrphaned = opts.isOrphaned ?? defaultIsOrphaned;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (!isOrphaned(pid)) return;
    stopped = true;
    clearInterval(timer);
    opts.logger?.warn(`orphan adapter process ${pid} detected; killing tree`);
    void killProcessTree(pid, { graceMs: 0, logger: opts.logger }).catch(() => {});
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** 缺省孤儿判定：进程不存在 → false（无需杀）；ppid 非当前进程 → 已沦为孤儿 */
function defaultIsOrphaned(pid: number): boolean {
  if (process.platform === "win32") return false;
  const ppid = readPpid(pid);
  if (ppid === null) return false;
  return ppid !== process.pid;
}

/** POSIX /proc/<pid>/stat 解析 ppid；comm 可含空格/括号，从最后一个 ')' 之后取字段 */
function readPpid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end === -1) return null;
    const fields = stat.slice(end + 1).trim().split(/\s+/);
    return Number(fields[1]);
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
