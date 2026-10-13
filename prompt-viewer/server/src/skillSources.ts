/**
 * 技能来源档读取（server/skill-sources.json）。
 *
 * 与 skillCategories.ts 同范式的 gitignore 本地档，但只读（无 PUT）：
 * 来源是人工考证的结论（a1 skill get 对比 desc / skills-lock.json / 插件市场），
 * 不适合在 UI 里随手改。文件缺失/损坏一律降级为空映射（来源列显示「—」），绝不抛错。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SkillSource } from "./types.js";

const SOURCES: readonly SkillSource[] = [
  "aone",
  "npx",
  "plugin",
  "builtin",
  "official",
  "personal",
  "unknown",
];

function sourcesPath(): string {
  return path.resolve(import.meta.dirname, "../skill-sources.json");
}

/** 读档（同步，配合 index.ts 的 TTL 缓存）；非法值丢弃 */
export function readSkillSources(): Map<string, SkillSource> {
  const index = new Map<string, SkillSource>();
  try {
    const j = JSON.parse(readFileSync(sourcesPath(), "utf8")) as { sources?: unknown };
    if (j.sources && typeof j.sources === "object") {
      for (const [name, src] of Object.entries(j.sources as Record<string, unknown>)) {
        if (typeof src === "string" && (SOURCES as readonly string[]).includes(src)) {
          index.set(name, src as SkillSource);
        }
      }
    }
  } catch {
    // 缺失/损坏 → 空映射
  }
  return index;
}
