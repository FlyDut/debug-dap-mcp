/**
 * 模板引擎（DESIGN.md §4.3 固化）——唯一定义的"参数注入点"，消除一切拼接特例。
 *
 * 变量集仅：${port} ${socketPath} ${serverPath} ${program} ${cwd} ${env:NAME} ${npmRoot}。
 * 无模板语法的字符串原样通过；未知变量 → usage 类配置错误（E-U3 变体，带字段路径）；
 * ${env:NAME} 未定义 → 展开失败即配置错误（明确报错）。词法替换、单遍扫描：
 * 替换产生的文本不再被解析（不重分词、不递归）。
 */

import { DebugToolError } from "./errors.js";

/** 静态（非 env）模板变量全集（DESIGN.md §4.3 表） */
export const TEMPLATE_VARIABLES = [
  "port",
  "socketPath",
  "serverPath",
  "program",
  "cwd",
  "npmRoot",
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export interface TemplateContext {
  port?: string | number;
  socketPath?: string;
  serverPath?: string;
  program?: string;
  cwd?: string;
  npmRoot?: string;
  /** 环境变量快照；${env:NAME} 从此读取 */
  env?: Record<string, string | undefined>;
}

const STATIC_VARIABLES: ReadonlySet<string> = new Set(TEMPLATE_VARIABLES);

const TOKEN = /\$\{([^}]*)\}/g;

function fail(variable: string, fieldPath: string | undefined, reason?: string): never {
  const at = fieldPath === undefined ? "" : ` at '${fieldPath}'`;
  throw new DebugToolError("usage", `${reason ?? `unknown template variable '${variable}'`}${at}`, {
    variable,
    ...(fieldPath !== undefined ? { fieldPath } : {}),
  });
}

/**
 * 展开模板字符串。ctx 提供各静态变量与 env；fieldPath 为出错字段路径
 * （如 "adapters.dlv.args[0]"），仅用于报错定位，不参与替换。
 * deferred 为"延迟变量"集合（Ruling：${port}/${socketPath} 由 transport 层在 spawn 前
 * 替换）——命中的变量原样保留 `${var}` 字面，不查 ctx、不报错。既有调用方不传该参，
 * 行为不变。无匹配时返回原串。
 */
export function renderTemplate(
  template: string,
  ctx?: TemplateContext,
  fieldPath?: string,
  deferred?: ReadonlySet<string>,
): string {
  const values = ctx ?? {};
  const env = values.env ?? {};
  return template.replace(TOKEN, (whole, raw: string) => {
    if (deferred !== undefined && deferred.has(raw)) return whole;
    if (raw.startsWith("env:")) {
      const name = raw.slice(4);
      if (name === "") return fail("env:", fieldPath);
      const value = env[name];
      if (value === undefined) {
        return fail(`env:${name}`, fieldPath, `template environment variable '${name}' is not defined`);
      }
      return value;
    }
    if (STATIC_VARIABLES.has(raw)) {
      const value = (values as Record<string, unknown>)[raw];
      if (value === undefined || value === null) {
        return fail(raw, fieldPath, `template variable '${raw}' has no value`);
      }
      return String(value);
    }
    return fail(raw, fieldPath);
  });
}
