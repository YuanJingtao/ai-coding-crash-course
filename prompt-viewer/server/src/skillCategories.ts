/**
 * 技能分类档读写（server/skill-categories.json）。
 *
 * 与 skillScopes.ts 的 readProjectRoots 同范式：一个 gitignore 的本地配置文件。
 * 分类是 name→categoryId 的**全局映射**，不绑定具体日志，故切换日志自动套用同一套分组。
 * 文件缺失/损坏一律降级为空档（所有技能落「未分类」），绝不抛错中断解析。
 */
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillCategoriesDoc, SkillCategory, SkillCategoryColor } from "./types.js";

/** 合法色板（与 web/src/index.css 的 6 色 neon 对应）；PUT 校验与兜底配色都用它 */
export const CATEGORY_COLORS: readonly SkillCategoryColor[] = [
  "neon-cyan",
  "neon-amber",
  "neon-purple",
  "neon-green",
  "neon-red",
  "neon-blue",
];

function categoriesPath(): string {
  return path.resolve(import.meta.dirname, "../skill-categories.json");
}

function isColor(v: unknown): v is SkillCategoryColor {
  return typeof v === "string" && (CATEGORY_COLORS as readonly string[]).includes(v);
}

/** 把任意 JSON 收敛成合法档：坏字段丢弃/兜底、id 去重、assignment 只保留指向已知分类者；永不抛错 */
export function normalizeDoc(raw: unknown): SkillCategoriesDoc {
  if (!raw || typeof raw !== "object") return { categories: [], assignments: {} };
  const obj = raw as { categories?: unknown; assignments?: unknown };

  const parsed: SkillCategory[] = Array.isArray(obj.categories)
    ? obj.categories.flatMap((c, i) => {
        if (!c || typeof c !== "object") return [];
        const e = c as { id?: unknown; label?: unknown; color?: unknown; order?: unknown; parentId?: unknown };
        if (typeof e.id !== "string" || e.id === "") return [];
        return [
          {
            id: e.id,
            label: typeof e.label === "string" && e.label !== "" ? e.label : e.id,
            color: isColor(e.color) ? e.color : CATEGORY_COLORS[i % CATEGORY_COLORS.length],
            order: typeof e.order === "number" && Number.isFinite(e.order) ? e.order : i,
            parentId: typeof e.parentId === "string" && e.parentId !== "" ? e.parentId : null,
          },
        ];
      })
    : [];

  const known = new Set<string>();
  const categories: SkillCategory[] = [];
  for (const c of parsed) {
    if (known.has(c.id)) continue;
    known.add(c.id);
    categories.push(c);
  }

  // parentId 收敛：必须指向已知且非自身的节点；手改 JSON 造成的环链断开为顶级
  const byId = new Map(categories.map((c) => [c.id, c]));
  for (const c of categories) {
    if (c.parentId !== null && (!byId.has(c.parentId) || c.parentId === c.id)) c.parentId = null;
  }
  for (const c of categories) {
    const seen = new Set<string>([c.id]);
    for (let cur = c.parentId; cur !== null; ) {
      if (seen.has(cur)) {
        c.parentId = null;
        break;
      }
      seen.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
  }

  const assignments: Record<string, string> = {};
  if (obj.assignments && typeof obj.assignments === "object") {
    for (const [name, catId] of Object.entries(obj.assignments as Record<string, unknown>)) {
      if (typeof catId === "string" && known.has(catId)) assignments[name] = catId;
    }
  }

  return { categories, assignments };
}

/** 读档（同步，配合 index.ts 的 TTL 缓存）；缺失/损坏 → 空档 */
export function readCategoriesDoc(): SkillCategoriesDoc {
  try {
    return normalizeDoc(JSON.parse(readFileSync(categoriesPath(), "utf8")));
  } catch {
    return { categories: [], assignments: {} };
  }
}

/** 原子写档：先落 .tmp 再 rename，避免半截文件被读到 */
export async function writeCategoriesDoc(doc: SkillCategoriesDoc): Promise<void> {
  const target = categoriesPath();
  const tmp = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

/** name → categoryId（normalizeDoc 已滤掉孤儿 assignment，此处直接建索引） */
export function buildCategoryIndex(doc: SkillCategoriesDoc): Map<string, string> {
  return new Map(Object.entries(doc.assignments));
}
