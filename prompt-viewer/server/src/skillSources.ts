/**
 * 技能来源档读取（server/skill-sources.json）。
 *
 * 与 skillCategories.ts 同范式的 gitignore 本地档，但只读（无 PUT）：
 * 来源是人工考证的结论（a1 skill get 对比 desc / skills-lock.json / 插件市场），
 * 不适合在 UI 里随手改。文件缺失/损坏一律降级为空映射（来源列显示「—」），绝不抛错。
 *
 * 两段互相独立：
 * `sources` —— name → 获得渠道（人工考证，注册表推不出来，如 aone vs 手动放置）；
 * `vendors` —— name → 上游作者归属，**仅用于覆盖/兜底** skillProvenance 的自动判定。
 *              典型场景是内部包：dws 有 Apache-2.0 + NOTICE 证明是钉钉官方，但无公网 repo，
 *              扫注册表得不到 vendor，只能在这里指定。能从 repo owner 判定的不必写。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SkillSource, SkillVendor } from "./types.js";

const SOURCES: readonly SkillSource[] = [
  "aone",
  "npx",
  "plugin",
  "builtin",
  "manual",
  "personal",
  "unknown",
];

const VENDORS: readonly SkillVendor[] = ["anthropic", "vercel", "alibaba", "qoder", "community"];

/** 来源档：两个全局映射，均可为空 */
export interface SkillSourcesDoc {
  sources: Map<string, SkillSource>;
  vendors: Map<string, SkillVendor>;
}

function sourcesPath(): string {
  return path.resolve(import.meta.dirname, "../skill-sources.json");
}

/** 按白名单收一段 name→枚举 映射；非法值丢弃 */
function readSection<T extends string>(raw: unknown, allowed: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  if (raw && typeof raw === "object") {
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && (allowed as readonly string[]).includes(v)) {
        index.set(name, v as T);
      }
    }
  }
  return index;
}

/** 读档（同步，配合 index.ts 的 TTL 缓存） */
export function readSkillSources(): SkillSourcesDoc {
  try {
    const j = JSON.parse(readFileSync(sourcesPath(), "utf8")) as {
      sources?: unknown;
      vendors?: unknown;
    };
    return {
      sources: readSection(j.sources, SOURCES),
      vendors: readSection(j.vendors, VENDORS),
    };
  } catch {
    // 缺失/损坏 → 空映射
    return { sources: new Map(), vendors: new Map() };
  }
}
