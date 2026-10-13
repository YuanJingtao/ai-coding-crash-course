import { useEffect, useMemo, useState } from "react";
import type { SkillCategoriesDoc, SkillCategory, SkillCategoryColor } from "../types";
import {
  CATEGORY_COLORS,
  COLOR_CLASS,
  childrenMap,
  depthOf,
  descendantIds,
  newCategoryId,
  treeOrder,
} from "../skillCategories";

interface Props {
  doc: SkillCategoriesDoc;
  /** 整档写回（读-改-写）；失败时抛出，本组件就地提示 */
  onSave: (next: SkillCategoriesDoc) => Promise<void>;
  onClose: () => void;
}

/** order 语义为「同级内序号」：提交前按同级重排为 1..n */
const reindex = (cats: SkillCategory[]): SkillCategory[] => {
  const orderById = new Map<string, number>();
  for (const [, siblings] of childrenMap(cats)) siblings.forEach((c, i) => orderById.set(c.id, i + 1));
  return cats.map((c) => ({ ...c, order: orderById.get(c.id) ?? 1 }));
};

/**
 * 分类管理弹窗：分类是一棵树（parentId）。支持增 / 改名 / 换色 / 同级排序 /
 * 建子分类 / 改父级 / 删除（子级上提）。弹窗骨架：fixed 遮罩 + Esc + stopPropagation。
 * 每个离散动作即时写回（单用户本地工具，无需「保存/取消」两态）。
 */
export function CategoryManager({ doc, onSave, onClose }: Props) {
  // 草稿即权威：打开时从 doc 初始化一次；会话内的增删改都以草稿为准
  const [cats, setCats] = useState<SkillCategory[]>(() => [...doc.categories]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cm = useMemo(() => childrenMap(cats), [cats]);
  const byId = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const ordered = useMemo(() => treeOrder(cats), [cats]);

  /** 写回整档；assignments 由调用方给出（删除时需剪掉孤儿） */
  const persist = async (nextCats: SkillCategory[], nextAssignments: Record<string, string>) => {
    setBusy(true);
    setError(null);
    try {
      await onSave({ categories: reindex(nextCats), assignments: nextAssignments });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const countOf = (id: string) => Object.values(doc.assignments).filter((v) => v === id).length;

  const addChild = (parentId: string | null) => {
    const siblingCount = (childrenMap(cats).get(parentId) ?? []).length;
    const next = [
      ...cats,
      {
        id: newCategoryId(),
        label: "新分类",
        color: CATEGORY_COLORS[cats.length % CATEGORY_COLORS.length] as SkillCategoryColor,
        order: siblingCount + 1,
        parentId,
      },
    ];
    setCats(next);
    void persist(next, doc.assignments);
  };

  // 改名：输入期只改草稿，失焦/回车才落盘（避免每敲一个字一次 PUT）
  const renameLocal = (id: string, label: string) =>
    setCats((cs) => cs.map((c) => (c.id === id ? { ...c, label } : c)));

  const setColor = (id: string, color: SkillCategoryColor) => {
    const next = cats.map((c) => (c.id === id ? { ...c, color } : c));
    setCats(next);
    void persist(next, doc.assignments);
  };

  /** 同级内上下移 */
  const move = (cat: SkillCategory, dir: -1 | 1) => {
    const siblings = (cm.get(cat.parentId) ?? []).slice();
    const i = siblings.findIndex((x) => x.id === cat.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= siblings.length) return;
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    const orderById = new Map(siblings.map((c, idx) => [c.id, idx + 1]));
    const next = cats.map((c) => (orderById.has(c.id) ? { ...c, order: orderById.get(c.id)! } : c));
    setCats(next);
    void persist(next, doc.assignments);
  };

  const setParent = (cat: SkillCategory, parentId: string | null) => {
    if (parentId === cat.parentId) return;
    // order 置大，persist 的 reindex 会把它排到新同级的末尾
    const next = cats.map((c) => (c.id === cat.id ? { ...c, parentId, order: 9999 } : c));
    setCats(next);
    void persist(next, doc.assignments);
  };

  const remove = (cat: SkillCategory) => {
    const n = countOf(cat.id);
    const kids = (cm.get(cat.id) ?? []).length;
    if (n > 0 || kids > 0) {
      const parentLabel = cat.parentId ? (byId.get(cat.parentId)?.label ?? "顶级") : "顶级";
      const parts = [`删除分类「${cat.label}」？`];
      if (n) parts.push(`会解除其下 ${n} 个技能的归类`);
      if (kids) parts.push(`${kids} 个子分类将上提到「${parentLabel}」级`);
      if (!window.confirm(parts.join("；"))) return;
    }
    const nextCats = cats
      .filter((c) => c.id !== cat.id)
      .map((c) => (c.parentId === cat.id ? { ...c, parentId: cat.parentId } : c));
    const nextAssignments: Record<string, string> = {};
    for (const [name, cid] of Object.entries(doc.assignments)) {
      if (cid !== cat.id) nextAssignments[name] = cid;
    }
    setCats(nextCats);
    void persist(nextCats, nextAssignments);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div
        className="flex max-h-[82vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-ink-700 px-4 py-2.5">
          <span className="font-mono text-[13px] font-bold text-neon-purple">🏷 管理技能分类</span>
          <span className="font-mono text-[11px] text-mist-500">{cats.length} 个分类（树形）</span>
          <button
            className="ml-auto shrink-0 rounded px-2 py-0.5 font-mono text-[13px] text-mist-400 hover:bg-ink-800 hover:text-mist-100"
            onClick={onClose}
            title="关闭（Esc）"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error && (
            <div className="mb-2 rounded border border-neon-red/40 bg-neon-red/5 px-3 py-1.5 text-[12px] text-neon-red">
              保存失败：{error}
            </div>
          )}
          {cats.length === 0 && (
            <div className="px-2 py-6 text-center text-[12px] text-mist-500">
              还没有分类。点下方「+ 新建分类」开始，然后在 Skills 明细里把技能归进去。
            </div>
          )}
          <div className="space-y-1.5">
            {ordered.map((c) => {
              const cls = COLOR_CLASS[c.color];
              const depth = depthOf(c, byId);
              const siblings = cm.get(c.parentId) ?? [];
              const si = siblings.findIndex((x) => x.id === c.id);
              const forbidden = descendantIds(c, cm); // 改父级时排除自身与后代，避免成环
              return (
                <div
                  key={c.id}
                  className={`flex items-center gap-2 rounded-md border ${cls.border} ${cls.chip} px-2.5 py-1.5`}
                  style={depth ? { marginLeft: depth * 20 } : undefined}
                >
                  <span className="flex shrink-0 flex-col">
                    <button
                      className="px-0.5 text-[11px] text-mist-500 hover:text-mist-100 disabled:opacity-30"
                      onClick={() => move(c, -1)}
                      disabled={si === 0 || busy}
                      title="在同级中上移"
                    >
                      ▲
                    </button>
                    <button
                      className="px-0.5 text-[11px] text-mist-500 hover:text-mist-100 disabled:opacity-30"
                      onClick={() => move(c, 1)}
                      disabled={si === siblings.length - 1 || busy}
                      title="在同级中下移"
                    >
                      ▼
                    </button>
                  </span>

                  <input
                    className={`min-w-0 flex-1 rounded border border-ink-700 bg-ink-950/60 px-2 py-1 font-mono text-[12.5px] ${cls.text} outline-none focus:border-neon-purple/60`}
                    value={c.label}
                    disabled={busy}
                    onChange={(e) => renameLocal(c.id, e.target.value)}
                    onBlur={() => void persist(cats, doc.assignments)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                    placeholder="分类名（这个分类是干什么用的）"
                  />

                  <span className="shrink-0 font-mono text-[10.5px] text-mist-500" title="直接归类到该分类的技能数">
                    {countOf(c.id)} 个
                  </span>

                  <select
                    className="shrink-0 rounded border border-ink-700 bg-ink-950/60 px-1 py-0.5 font-mono text-[10.5px] text-mist-400 outline-none disabled:opacity-50"
                    value={c.parentId ?? ""}
                    disabled={busy}
                    title="父分类（改父级）"
                    onChange={(e) => setParent(c, e.target.value === "" ? null : e.target.value)}
                  >
                    <option value="">顶级</option>
                    {cats
                      .filter((o) => o.id !== c.id && !forbidden.has(o.id))
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          ↳ {o.label}
                        </option>
                      ))}
                  </select>

                  <span className="flex shrink-0 items-center gap-1">
                    {CATEGORY_COLORS.map((col) => (
                      <button
                        key={col}
                        className={`h-3.5 w-3.5 rounded-full ${COLOR_CLASS[col].swatch} ${
                          col === c.color ? "ring-2 ring-mist-100/70" : "opacity-50 hover:opacity-100"
                        }`}
                        onClick={() => setColor(c.id, col)}
                        disabled={busy}
                        title={col}
                      />
                    ))}
                  </span>

                  <button
                    className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-mist-400 hover:bg-neon-purple/10 hover:text-neon-purple disabled:opacity-30"
                    onClick={() => addChild(c.id)}
                    disabled={busy}
                    title="新建子分类"
                  >
                    ＋子
                  </button>
                  <button
                    className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-mist-500 hover:bg-neon-red/10 hover:text-neon-red disabled:opacity-30"
                    onClick={() => remove(c)}
                    disabled={busy}
                    title="删除分类（子分类上提）"
                  >
                    🗑
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-ink-700 px-4 py-2.5">
          <button
            className="rounded border border-neon-purple/50 bg-neon-purple/15 px-3 py-1 font-mono text-[12px] text-neon-purple hover:bg-neon-purple/25 disabled:opacity-40"
            onClick={() => addChild(null)}
            disabled={busy}
          >
            + 新建分类
          </button>
          {busy && <span className="font-mono text-[11px] text-mist-500">保存中…</span>}
          <span className="ml-auto font-mono text-[10.5px] text-mist-500">改动即时写入 server/skill-categories.json</span>
        </div>
      </div>
    </div>
  );
}
