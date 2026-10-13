/**
 * 技能分类的前端共享件：色板 + 静态类名映射 + id 生成。
 * 与 server/src/skillCategories.ts 的 CATEGORY_COLORS 同构（改一处需同步）。
 */
import type { SkillCategory, SkillCategoryColor } from "./types";

/** 色板顺序（新建分类时按此轮换取色） */
export const CATEGORY_COLORS: readonly SkillCategoryColor[] = [
  "neon-cyan",
  "neon-amber",
  "neon-purple",
  "neon-green",
  "neon-red",
  "neon-blue",
];

/**
 * color → 静态 Tailwind 类。必须整串字面量：动态拼接（`text-${color}`）不会被
 * Tailwind JIT 扫到，导致类名不生成。
 */
export const COLOR_CLASS: Record<
  SkillCategoryColor,
  { text: string; chip: string; border: string; swatch: string }
> = {
  "neon-cyan": { text: "text-neon-cyan", chip: "bg-neon-cyan/10", border: "border-neon-cyan/40", swatch: "bg-neon-cyan" },
  "neon-amber": { text: "text-neon-amber", chip: "bg-neon-amber/10", border: "border-neon-amber/40", swatch: "bg-neon-amber" },
  "neon-purple": { text: "text-neon-purple", chip: "bg-neon-purple/10", border: "border-neon-purple/40", swatch: "bg-neon-purple" },
  "neon-green": { text: "text-neon-green", chip: "bg-neon-green/10", border: "border-neon-green/40", swatch: "bg-neon-green" },
  "neon-red": { text: "text-neon-red", chip: "bg-neon-red/10", border: "border-neon-red/40", swatch: "bg-neon-red" },
  "neon-blue": { text: "text-neon-blue", chip: "bg-neon-blue/10", border: "border-neon-blue/40", swatch: "bg-neon-blue" },
};

/** 生成稳定且唯一的分类 id（改名只动 label，id 不变，assignments 靠它引用） */
export function newCategoryId(): string {
  return `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---- 分类树工具 ----

/** parentId → 子节点（同级按 order 升序）；顶级挂在 null 下 */
export function childrenMap(cats: SkillCategory[]): Map<string | null, SkillCategory[]> {
  const m = new Map<string | null, SkillCategory[]>();
  for (const c of cats) {
    const arr = m.get(c.parentId) ?? [];
    arr.push(c);
    m.set(c.parentId, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.order - b.order);
  return m;
}

/** 顶级分类（按 order 升序） */
export function topCategories(cats: SkillCategory[]): SkillCategory[] {
  return childrenMap(cats).get(null) ?? [];
}

/** 展示用 path 标签：祖先链 label 以 " / " 连接，如 "dataworks / 官方" */
export function pathLabel(cat: SkillCategory, byId: Map<string, SkillCategory>): string {
  const parts: string[] = [];
  let cur: SkillCategory | undefined = cat;
  for (let depth = 0; cur && depth < 8; depth++) {
    parts.unshift(cur.label);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(" / ");
}

/** 某节点的全部后代 id（改父级时排除自身与后代，避免成环） */
export function descendantIds(cat: SkillCategory, cm: Map<string | null, SkillCategory[]>): Set<string> {
  const out = new Set<string>([cat.id]);
  const stack = [cat.id];
  while (stack.length) {
    for (const child of cm.get(stack.pop()!) ?? []) {
      if (!out.has(child.id)) {
        out.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return out;
}

/** DFS 平铺（父→子，同级按 order），供管理弹窗按树序渲染 */
export function treeOrder(cats: SkillCategory[]): SkillCategory[] {
  const cm = childrenMap(cats);
  const out: SkillCategory[] = [];
  const walk = (parentId: string | null): void => {
    for (const c of cm.get(parentId) ?? []) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(null);
  return out;
}

/** 节点深度（顶级=0），供缩进 */
export function depthOf(cat: SkillCategory, byId: Map<string, SkillCategory>): number {
  let d = 0;
  let cur = cat.parentId ? byId.get(cat.parentId) : undefined;
  for (let i = 0; cur && i < 8; i++) {
    d++;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return d;
}
