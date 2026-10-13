import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type {
  ContextCategoryStats,
  ParsedLog,
  SkillCategoriesDoc,
  SkillCategory,
  SkillProvenance,
  SkillShareEntry,
  SkillScope,
  SkillSource,
  SkillVendor,
} from "../types";
import { fmtNum, fmtWindow } from "../format";
import { Badge, SectionCard } from "./SectionCard";
import { CategoryManager } from "./CategoryManager";
import { skillFileHref } from "../routes";
import { COLOR_CLASS, childrenMap, depthOf, pathLabel, treeOrder } from "../skillCategories";

type SortKey = "share" | "size" | "name";
const SORT_LABEL: Record<SortKey, string> = { share: "占比", size: "大小", name: "名称" };

/** 分组维度：按作用域（扫盘反推）/ 按用户手动分类 */
type Grouping = "scope" | "category";
const GROUPING_KEY = "prompt-viewer:skill-grouping";
const GROUPING_LABEL: Record<Grouping, string> = { scope: "按作用域", category: "按分类" };
function readGrouping(): Grouping {
  try {
    return localStorage.getItem(GROUPING_KEY) === "category" ? "category" : "scope";
  } catch {
    return "scope";
  }
}

/** 家目录缩写，位置列更易读 */
const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+\//, "~/");

/**
 * Skills 明细的可拖拽列，列宽存 localStorage。
 * flex 列（描述/位置）用 minmax(宽,1fr) 自动伸展吸收容器剩余宽度——宽屏下多出来的
 * 空间给这两列内容而不是留白或拉长比例条；拖拽为它们设置最小宽。其余列为固定 px，拖拽精确生效。
 * 增删列会使已存列宽失效（readColWidths 校验长度），回退默认值即可，无需迁移。
 */
const COLS = [
  { key: "name", label: "技能", align: "left", def: 150, min: 80, flex: false, fr: 0 },
  { key: "desc", label: "描述", align: "left", def: 200, min: 120, flex: true, fr: 1 },
  { key: "path", label: "位置", align: "left", def: 160, min: 120, flex: true, fr: 1.6 },
  { key: "source", label: "渠道", align: "left", def: 66, min: 52, flex: false, fr: 0 },
  { key: "vendor", label: "作者", align: "left", def: 118, min: 72, flex: false, fr: 0 },
  { key: "cat", label: "分类", align: "left", def: 120, min: 70, flex: false, fr: 0 },
  { key: "tokens", label: "tokens", align: "right", def: 84, min: 56, flex: false, fr: 0 },
  { key: "share", label: "占比", align: "right", def: 64, min: 44, flex: false, fr: 0 },
  { key: "bar", label: "", align: "left", def: 220, min: 60, flex: false, fr: 0 },
] as const;

const COLW_KEY = "prompt-viewer:skill-col-widths";
function readColWidths(): number[] {
  try {
    const raw = localStorage.getItem(COLW_KEY);
    if (raw) {
      const a: unknown = JSON.parse(raw);
      if (Array.isArray(a) && a.length === COLS.length && a.every((n) => typeof n === "number" && n > 0)) {
        return a as number[];
      }
    }
  } catch {
    // 忽略损坏值，回退默认
  }
  return COLS.map((c) => c.def);
}

/**
 * 表头与每行共用：列宽经外层容器的 --skill-cols 变量下发。拖拽只改这一个变量，
 * 行组件（memo）不会因列宽变化而重渲染，174 行也不卡。
 */
const GRID_COLS_STYLE = { gridTemplateColumns: "var(--skill-cols)" } as const;

/** 作用域分组的展示元数据（顺序即渲染顺序，与 /skills 的 Project/User/Plugin/Built-in 一致） */
const SCOPE_META: Record<SkillScope, { label: string; icon: string; text: string }> = {
  project: { label: "Project", icon: "📁", text: "text-neon-green" },
  user: { label: "User", icon: "👤", text: "text-neon-cyan" },
  plugin: { label: "Plugin", icon: "🔌", text: "text-neon-purple" },
  builtin: { label: "Built-in", icon: "⚙️", text: "text-neon-blue" },
  unknown: { label: "未知", icon: "❔", text: "text-mist-400" },
};
const SCOPE_ORDER: SkillScope[] = ["project", "user", "plugin", "builtin", "unknown"];

/**
 * 技能**渠道**（我怎么拿到的）的展示元数据；null（未收录）显示「—」。
 * 与「作者」列正交：同一技能可以是「从 Aone 市场下的」且「Anthropic 写的」。
 */
const SOURCE_META: Record<SkillSource, { label: string; cls: string; hint: string }> = {
  aone: {
    label: "aone",
    cls: "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan",
    hint: "Aone 技能市场下载（a1 skill get 可查到且 desc 一致，或确认为市场升级导致的 desc 漂移）",
  },
  npx: {
    label: "npx",
    cls: "border-neon-green/40 bg-neon-green/10 text-neon-green",
    hint: "skills CLI 安装（skills-lock.json / .skill-lock.json 有记录）",
  },
  plugin: {
    label: "插件",
    cls: "border-neon-purple/40 bg-neon-purple/10 text-neon-purple",
    hint: "qodercli 插件市场（plugin:skill 前缀技能）",
  },
  builtin: {
    label: "内置",
    cls: "border-ink-600 bg-ink-800/60 text-mist-400",
    hint: "qodercli 内置技能",
  },
  manual: {
    label: "手动",
    cls: "border-ink-600 bg-ink-800/40 text-mist-400",
    hint: "手动放置到技能目录（无安装凭据可查）",
  },
  personal: {
    label: "个人",
    cls: "border-neon-blue/40 bg-neon-blue/10 text-neon-blue",
    hint: "个人创建",
  },
  unknown: {
    label: "存疑",
    cls: "border-ink-600 bg-ink-800/40 text-mist-500",
    hint: "已删除或市场无权限等，来源无法考证",
  },
};

/**
 * 技能**作者**（上游是谁写的）的展示元数据。第一方厂商显示「官方·<厂商>」，
 * 个人/社区公开包统一显示「公版」。
 */
const VENDOR_META: Record<SkillVendor, { label: string; cls: string; whose: string }> = {
  anthropic: {
    label: "官方·Anthropic",
    cls: "border-neon-amber/40 bg-neon-amber/10 text-neon-amber",
    whose: "Anthropic（anthropics/skills）",
  },
  vercel: {
    label: "官方·Vercel",
    cls: "border-neon-amber/40 bg-neon-amber/10 text-neon-amber",
    whose: "Vercel（vercel-labs）",
  },
  alibaba: {
    label: "官方·阿里",
    cls: "border-neon-amber/40 bg-neon-amber/10 text-neon-amber",
    whose: "阿里巴巴 / 钉钉",
  },
  qoder: {
    label: "官方·Qoder",
    cls: "border-neon-amber/40 bg-neon-amber/10 text-neon-amber",
    whose: "Qoder",
  },
  community: {
    label: "公版",
    cls: "border-neon-cyan/30 bg-neon-cyan/5 text-neon-cyan",
    whose: "个人 / 社区公开发布的技能包",
  },
};

/** 证据强度的 TSV 文案（导出到 Excel 后要能独立读懂，不依赖 badge 样式） */
const EVIDENCE_LABEL: Record<SkillProvenance["evidence"], string> = {
  "install-record": "安装凭据",
  "catalog-match": "同名推断",
  manual: "人工指定",
};

/**
 * 作者 badge 的悬浮说明：证据强度必须让用户看得见——catalog-match 只是上游目录同名匹配，
 * 不证明本机这份就是从那儿装的（同名不同源会误判），故用虚线边框 + 文案双重提示。
 */function vendorHint(p: SkillShareEntry["provenance"], meta: { whose: string }): string {
  if (!p) return meta.whose;
  const lines = [`上游作者：${meta.whose}`];
  if (p.repo) lines.push(`仓库：${p.repo}`);
  if (p.identifier) lines.push(`标识：${p.identifier}`);
  lines.push(
    p.evidence === "install-record"
      ? "证据：本机安装凭据（确凿）"
      : p.evidence === "catalog-match"
        ? "证据：上游目录同名匹配（推断，可能同名不同源）"
        : "证据：人工指定（无 repo 凭据）",
  );
  if (p.installedAt) lines.push(`安装于：${p.installedAt.slice(0, 10)}`);
  if (p.url) lines.push("点击打开上游目录");
  return lines.join("\n");
}

/** 四分类的视觉映射（颜色与页面其他 section 呼应） */
const CAT_META: Record<
  ContextCategoryStats["key"],
  { icon: string; text: string; bar: string; chip: string }
> = {
  "system-prompt": { icon: "📜", text: "text-neon-cyan", bar: "bg-neon-cyan/70", chip: "bg-neon-cyan/10 border-neon-cyan/30" },
  "system-tools": { icon: "🛠", text: "text-neon-blue", bar: "bg-neon-blue/70", chip: "bg-neon-blue/10 border-neon-blue/30" },
  skills: { icon: "🧩", text: "text-neon-purple", bar: "bg-neon-purple/70", chip: "bg-neon-purple/10 border-neon-purple/30" },
  messages: { icon: "💬", text: "text-neon-green", bar: "bg-neon-green/70", chip: "bg-neon-green/10 border-neon-green/30" },
};

/** 一个分组（作用域组或分类树节点）；inbox = 未分类收件箱 */
interface SkillGroup {
  key: string;
  label: string;
  icon: string;
  textClass: string;
  items: SkillShareEntry[];
  children: SkillGroup[];
  depth: number;
  /** 含全部子级的技能数 / tokens（有子级的组表头显示子树合计） */
  subtreeCount: number;
  subtreeTokens: number;
  inbox?: boolean;
}

/** 一行分类占用：图标 + 名称 + tokens + 占窗口% + 比例条 */
function CategoryRow({
  cat,
  barPercent,
  dim,
}: {
  cat: { icon: string; label: string; tokensLabel: string; percentLabel: string; text: string; bar: string };
  barPercent: number;
  dim?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-md border border-ink-700/60 bg-ink-950/40 ${dim ? "opacity-60" : ""}`}>
      <span className="w-5 shrink-0 text-center text-[13px]">{cat.icon}</span>
      <span className={`w-32 shrink-0 font-mono text-[12px] font-bold ${cat.text}`}>{cat.label}</span>
      <span className="w-24 shrink-0 text-right font-mono text-[12px] text-mist-300">{cat.tokensLabel}</span>
      <span className="w-16 shrink-0 text-right font-mono text-[11.5px] text-mist-500">{cat.percentLabel}</span>
      <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-800">
        <span className={`block h-full rounded-full ${cat.bar}`} style={{ width: `${Math.min(barPercent, 100)}%` }} />
      </span>
    </div>
  );
}

/** Skills 明细中的一行；分类下拉即时写回（读-改-写整档）。memo：拖列宽时不重渲染 */
const SkillRow = memo(function SkillRow({
  s,
  effCat,
  maxShare,
  tree,
  saving,
  onAssign,
}: {
  s: SkillShareEntry;
  effCat: string | null;
  maxShare: number;
  /** 分类树（树下拉数据源） */
  tree: CategoryTree;
  saving: boolean;
  onAssign: (name: string, catId: string | null) => void;
}) {
  const prov = s.provenance;
  const vendorMeta = prov?.vendor ? VENDOR_META[prov.vendor] : null;
  return (
    <div
      className={`grid items-center gap-2 rounded-md border px-2.5 py-1.5 ${
        s.placeholder ? "border-ink-700/50 bg-ink-900/30 opacity-70" : "border-ink-700/70 bg-ink-900/50"
      }`}
      style={GRID_COLS_STYLE}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {s.path ? (
          <a
            href={skillFileHref(s.name)}
            target="_blank"
            rel="noreferrer"
            className={`min-w-0 truncate font-mono text-[12px] font-bold underline decoration-ink-600 decoration-dotted underline-offset-2 hover:decoration-neon-cyan ${
              s.placeholder ? "text-mist-500" : "text-neon-purple"
            }`}
            title={`新标签页查看技能文件 · ${shortPath(s.path)}`}
          >
            {s.name}
          </a>
        ) : (
          <code
            className="truncate font-mono text-[12px] font-bold text-mist-500"
            title="Built-in：磁盘无对应目录，没有技能文件可看"
          >
            {s.name}
          </code>
        )}
        {s.placeholder && (
          <span className="shrink-0 rounded border border-neon-red/40 bg-neon-red/10 px-1 py-px text-[9.5px] font-bold text-neon-red">
            占位
          </span>
        )}
      </span>
      {s.description ? (
        <span className="truncate text-[11px] text-mist-400" title={s.description}>
          {s.description}
        </span>
      ) : s.diskDescription ? (
        <span
          className="flex min-w-0 items-center gap-1 text-[11px] italic text-mist-500"
          title={`wire 未注入描述；此为磁盘 SKILL.md 兜底：${s.diskDescription}`}
        >
          <span className="shrink-0 not-italic text-[10px]" title="磁盘兜底描述（非 wire 注入）">
            💾
          </span>
          <span className="truncate">{s.diskDescription}</span>
        </span>
      ) : (
        <span
          className="truncate text-[11px] text-mist-500"
          title="无描述 —— 占位技能仅注入名字，且磁盘 SKILL.md 也读不到描述"
        >
          —
        </span>
      )}
      <span className="flex min-w-0 items-center gap-1">
        <code
          className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mist-500"
          title={s.path ?? "Built-in：磁盘无对应目录"}
        >
          {s.path ? shortPath(s.path) : "内置（磁盘无目录）"}
        </code>
        {s.path && (
          <a
            href={skillFileHref(s.name)}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded px-1 text-[11px] text-mist-400 hover:bg-ink-800 hover:text-neon-cyan"
            title="新标签页查看技能文件（SKILL.md 等）"
          >
            📄
          </a>
        )}
      </span>
      {s.source ? (
        <span className="flex min-w-0 items-center">
          <span
            className={`truncate rounded border px-1.5 py-px font-mono text-[10px] font-bold ${SOURCE_META[s.source].cls}`}
            title={SOURCE_META[s.source].hint}
          >
            {SOURCE_META[s.source].label}
          </span>
        </span>
      ) : (
        <span
          className="truncate text-[11px] text-mist-600"
          title="未收录于 server/skill-sources.json（渠道为人工考证维护）"
        >
          —
        </span>
      )}
      {vendorMeta ? (
        <span className="flex min-w-0 items-center">
          {/* catalog-match 是上游目录同名匹配（弱证据），用虚线边框与实心的 install-record 区分 */}
          {prov?.url ? (
            <a
              href={prov.url}
              target="_blank"
              rel="noreferrer"
              className={`truncate rounded border px-1.5 py-px font-mono text-[10px] font-bold underline decoration-dotted underline-offset-2 hover:decoration-solid ${vendorMeta.cls} ${
                prov.evidence === "catalog-match" ? "border-dashed" : ""
              }`}
              title={vendorHint(prov, vendorMeta)}
            >
              {vendorMeta.label}
            </a>
          ) : (
            <span
              className={`truncate rounded border px-1.5 py-px font-mono text-[10px] font-bold ${vendorMeta.cls} ${
                prov?.evidence === "catalog-match" ? "border-dashed" : ""
              }`}
              title={vendorHint(prov, vendorMeta)}
            >
              {vendorMeta.label}
            </span>
          )}
        </span>
      ) : (
        <span
          className="truncate text-[11px] text-mist-600"
          title="无出处凭据：本机注册表查不到上游 repo，且 skill-sources.json 未人工指定 vendor"
        >
          —
        </span>
      )}
      <CategoryTreeSelect
        value={effCat}
        tree={tree}
        disabled={saving}
        onChange={(cid) => onAssign(s.name, cid)}
      />
      <span className="text-right font-mono text-[11px] text-mist-400">{fmtNum(s.tokens)} tok</span>
      <span className="text-right font-mono text-[11px] text-mist-500">{s.sharePercent}%</span>
      <span className="h-2 min-w-0 overflow-hidden rounded-full bg-ink-800">
        <span
          className={`block h-full rounded-full ${s.placeholder ? "bg-neon-red/50" : "bg-neon-purple/70"}`}
          style={{ width: `${maxShare > 0 ? (s.sharePercent / maxShare) * 100 : 0}%` }}
        />
      </span>
    </div>
  );
});

/** 分类树数据（稳定引用）：供 SkillRow(memo) 与树下拉弹层共用 */
interface CategoryTree {
  /** 树序节点：缩进深度 + 是否有子级 */
  nodes: { id: string; depth: number; hasKids: boolean }[];
  /** id → 全路径 label（"dataworks / 官方"），触发按钮展示用 */
  labels: Record<string, string>;
  /** id → 节点自身 label，弹层树行展示用（层级已由缩进表达） */
  names: Record<string, string>;
  /** id → parentId，弹层按折叠集合过滤可见行用 */
  parentOf: Record<string, string | null>;
}

/**
 * 分类树下拉（替代扁平 select）：弹层为可折叠树，**默认全展开**；
 * 有子级的行点箭头折叠/展开、点行身选中该分类。
 * 弹层经 portal 挂到 body：SectionCard 的 backdrop-blur 会成为 fixed 后代的
 * 定位包含块，弹层若留在行内会被整体偏移（坐标按 section 而非视口解释）。
 * 外部点击 / Esc / 外层滚动关闭。
 */
const CategoryTreeSelect = memo(function CategoryTreeSelect({
  value,
  tree,
  disabled,
  onChange,
}: {
  value: string | null;
  tree: CategoryTree;
  disabled?: boolean;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const inside = (t: Node) =>
      !!rootRef.current?.contains(t) || !!popRef.current?.contains(t);
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // 捕获阶段：外层列表滚动时关闭（弹层自身滚动除外），避免弹层与行错位
    const onScroll = (e: Event) => {
      if (inside(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const flipUp = window.innerHeight - r.bottom < 300 && r.top > 300;
      setPos(
        flipUp
          ? { left: r.left, bottom: window.innerHeight - r.top + 4 }
          : { left: r.left, top: r.bottom + 4 },
      );
      setCollapsed(new Set()); // 每次打开回到「默认全展开」
    }
    setOpen(!open);
  };

  /** 可见行：任一祖先被折叠则隐藏 */
  const visible = useMemo(() => {
    if (collapsed.size === 0) return tree.nodes;
    return tree.nodes.filter((n) => {
      for (let p = tree.parentOf[n.id]; p; p = tree.parentOf[p]) {
        if (collapsed.has(p)) return false;
      }
      return true;
    });
  }, [tree, collapsed]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        title="设置该技能的手动分类（跨日志生效）· 树形选择"
        className={`flex w-full min-w-0 items-center gap-1 rounded border bg-ink-950/70 px-1 py-0.5 text-left font-mono text-[10.5px] outline-none disabled:opacity-50 ${
          value ? "border-ink-600 text-mist-200" : "border-neon-amber/40 text-neon-amber"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{value ? (tree.labels[value] ?? value) : "未分类"}</span>
        <span className="shrink-0 text-[8px] text-mist-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && pos &&
        createPortal(
          <div
            ref={popRef}
            className="fixed z-50 max-h-[280px] w-[240px] overflow-y-auto rounded-md border border-ink-600 bg-ink-900 p-1 shadow-2xl"
            style={pos}
          >
          <button
            type="button"
            className={`flex w-full items-center rounded px-1.5 py-1 text-left font-mono text-[11px] ${
              value === null ? "bg-neon-purple/15 text-neon-purple" : "text-mist-300 hover:bg-ink-800"
            }`}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            未分类
          </button>
          {visible.map((n) => (
            <div
              key={n.id}
              className={`flex w-full items-center gap-1 rounded px-1.5 py-1 font-mono text-[11px] ${
                value === n.id ? "bg-neon-purple/15 text-neon-purple" : "text-mist-300 hover:bg-ink-800"
              }`}
              style={{ marginLeft: n.depth * 12 }}
            >
              {n.hasKids ? (
                <button
                  type="button"
                  className="w-3 shrink-0 text-[9px] text-mist-500 hover:text-mist-100"
                  title={collapsed.has(n.id) ? "展开子分类" : "折叠子分类"}
                  onClick={() =>
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (next.has(n.id)) next.delete(n.id);
                      else next.add(n.id);
                      return next;
                    })
                  }
                >
                  {collapsed.has(n.id) ? "▸" : "▾"}
                </button>
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                title={tree.labels[n.id]}
                onClick={() => {
                  onChange(n.id);
                  setOpen(false);
                }}
              >
                {tree.names[n.id]}
              </button>
            </div>
          ))}
          </div>,
          document.body,
        )}
    </div>
  );
});

/** /context 式上下文占用面板 —— wire 真值口径（见 docs/context-panel-validation.md） */
export function ContextPanel({
  log,
  categoriesDoc,
  onSaveCategories,
}: {
  log: ParsedLog;
  categoriesDoc: SkillCategoriesDoc;
  onSaveCategories: (next: SkillCategoriesDoc) => Promise<void>;
}) {
  const ctx = log.context;
  const hasWindow = ctx.contextLength !== null;
  // 比例条分母：有窗口用窗口；没有则退化为「已用 = 100%」
  const barTotal = ctx.contextLength !== null ? ctx.contextLength : Math.max(ctx.usedTokens, 1);
  const usedPctOfBar = (ctx.usedTokens / barTotal) * 100;
  // 全局最大份额（比例条归一化用）；数组按作用域分组排序，首元素不再是最大值
  const maxShare = ctx.skills.length > 0 ? Math.max(...ctx.skills.map((s) => s.sharePercent)) : 0;
  const placeholderCount = ctx.skills.filter((s) => s.placeholder).length;

  const [sortKey, setSortKey] = useState<SortKey>("share");
  const [grouping, setGrouping] = useState<Grouping>(readGrouping);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [managing, setManaging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(GROUPING_KEY, grouping);
    } catch {
      // localStorage 不可用时放弃持久化
    }
  }, [grouping]);

  // ---- 列宽（可拖拽）----
  const [colWidths, setColWidths] = useState<number[]>(readColWidths);
  const colWidthsRef = useRef(colWidths);
  useEffect(() => {
    colWidthsRef.current = colWidths;
  }, [colWidths]);
  const colTemplate = useMemo(
    () =>
      COLS.map((c, i) =>
        c.flex ? `minmax(${Math.round(colWidths[i])}px,${c.fr}fr)` : `${Math.round(colWidths[i])}px`,
      ).join(" "),
    [colWidths],
  );
  const persistColWidths = () => {
    try {
      localStorage.setItem(COLW_KEY, JSON.stringify(colWidthsRef.current));
    } catch {
      // 忽略
    }
  };
  const dragRef = useRef<{ index: number; startX: number; startW: number } | null>(null);
  const startResize = (index: number) => (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    dragRef.current = { index, startX: e.clientX, startW: colWidthsRef.current[index] };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = [...colWidthsRef.current];
      next[d.index] = Math.max(COLS[d.index].min, d.startW + (ev.clientX - d.startX));
      colWidthsRef.current = next;
      setColWidths(next);
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      persistColWidths();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const resetCol = (index: number) => {
    const next = [...colWidthsRef.current];
    next[index] = COLS[index].def;
    colWidthsRef.current = next;
    setColWidths(next);
    persistColWidths();
  };

  const sortedCats = useMemo(
    () => [...categoriesDoc.categories].sort((a, b) => a.order - b.order),
    [categoriesDoc.categories],
  );

  /**
   * 交互层一律以最新的 categoriesDoc.assignments 为准（按 name join），而非
   * s.categoryId —— 后者是解析那一刻的快照，用户改分类后会变旧。这样归类即时生效、
   * 无需重新解析当前日志。
   */
  const effCat = (name: string): string | null => categoriesDoc.assignments[name] ?? null;

  const catById = useMemo(
    () => new Map(categoriesDoc.categories.map((c) => [c.id, c])),
    [categoriesDoc.categories],
  );

  const groups = useMemo<SkillGroup[]>(() => {
    const tokensOf = (items: SkillShareEntry[]) => items.reduce((a, s) => a + s.tokens, 0);
    if (grouping === "scope") {
      return SCOPE_ORDER.map((scope) => {
        const items = ctx.skills.filter((s) => s.scope === scope);
        return {
          key: `scope:${scope}`,
          label: SCOPE_META[scope].label,
          icon: SCOPE_META[scope].icon,
          textClass: SCOPE_META[scope].text,
          items,
          children: [],
          depth: 0,
          subtreeCount: items.length,
          subtreeTokens: tokensOf(items),
        };
      }).filter((g) => g.items.length > 0);
    }
    // 分类树：递归构建，父组表头显示子树合计
    const cm = childrenMap(sortedCats);
    const build = (c: SkillCategory, depth: number): SkillGroup => {
      const items = ctx.skills.filter((s) => effCat(s.name) === c.id);
      const children = (cm.get(c.id) ?? []).map((ch) => build(ch, depth + 1));
      return {
        key: `cat:${c.id}`,
        label: c.label,
        icon: "🏷",
        textClass: COLOR_CLASS[c.color]?.text ?? "text-neon-purple",
        items,
        children,
        depth,
        subtreeCount: items.length + children.reduce((a, g) => a + g.subtreeCount, 0),
        subtreeTokens: tokensOf(items) + children.reduce((a, g) => a + g.subtreeTokens, 0),
      };
    };
    const gs = (cm.get(null) ?? []).map((c) => build(c, 0)).filter((g) => g.subtreeCount > 0);
    // 未分类收件箱：任何没归类（或指向已删分类）的技能都落这里，一眼可见待处理
    const inbox = ctx.skills.filter((s) => {
      const id = effCat(s.name);
      return id === null || !catById.has(id);
    });
    gs.push({
      key: "cat:__inbox__",
      label: "未分类",
      icon: "📥",
      textClass: "text-neon-amber",
      items: inbox,
      children: [],
      depth: 0,
      subtreeCount: inbox.length,
      subtreeTokens: tokensOf(inbox),
      inbox: true,
    });
    return gs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouping, ctx.skills, sortedCats, catById, categoriesDoc.assignments]);

  /** 分类树下拉数据源：树序节点 + 全路径/自身 label + 父级索引 */
  const tree = useMemo<CategoryTree>(() => {
    const cm = childrenMap(sortedCats);
    return {
      nodes: treeOrder(sortedCats).map((c) => ({
        id: c.id,
        depth: depthOf(c, catById),
        hasKids: (cm.get(c.id) ?? []).length > 0,
      })),
      labels: Object.fromEntries(sortedCats.map((c) => [c.id, pathLabel(c, catById)])),
      names: Object.fromEntries(sortedCats.map((c) => [c.id, c.label])),
      parentOf: Object.fromEntries(sortedCats.map((c) => [c.id, c.parentId])),
    };
  }, [sortedCats, catById]);

  const inboxCount = grouping === "category" ? (groups.find((g) => g.inbox)?.items.length ?? 0) : 0;

  const sortItems = (items: SkillShareEntry[]): SkillShareEntry[] =>
    [...items].sort((a, b) =>
      sortKey === "name"
        ? a.name.localeCompare(b.name)
        : sortKey === "size"
          ? b.chars - a.chars
          : b.sharePercent - a.sharePercent,
    );

  /** TSV 单元格：制表符/换行会破坏列对齐，压成空格 */
  const cell = (v: string | number | null | undefined) =>
    String(v ?? "").replace(/[\t\r\n]+/g, " ").trim();

  /** 按当前分组与排序生成 TSV（含分组列），粘贴到 Excel 即成表格 */
  const buildTsv = (): string => {
    const rows: string[][] = [
      ["分组", "技能", "描述", "位置", "渠道", "作者", "出处", "证据", "分类", "tokens", "占比%", "占位"],
    ];
    const walk = (g: SkillGroup, path: string) => {
      const gpath = path ? `${path} / ${g.label}` : g.label;
      for (const s of sortItems(g.items)) {
        const cid = effCat(s.name);
        rows.push([
          gpath,
          s.name,
          cell(s.description ?? s.diskDescription),
          s.path ? shortPath(s.path) : "内置",
          s.source ? SOURCE_META[s.source].label : "",
          s.provenance?.vendor ? VENDOR_META[s.provenance.vendor].label : "",
          s.provenance?.url ?? s.provenance?.identifier ?? "",
          s.provenance ? EVIDENCE_LABEL[s.provenance.evidence] : "",
          cid ? (tree.labels[cid] ?? cid) : "未分类",
          String(s.tokens),
          String(s.sharePercent),
          s.placeholder ? "是" : "",
        ]);
      }
      g.children.forEach((ch) => walk(ch, gpath));
    };
    groups.forEach((g) => walk(g, ""));
    return rows.map((r) => r.map(cell).join("\t")).join("\n");
  };

  const copyTsv = async () => {
    try {
      await navigator.clipboard.writeText(buildTsv());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 忽略剪贴板失败 */
    }
  };

  // useCallback：引用稳定，SkillRow(memo) 在拖列宽等无关重渲染时不重渲染
  const assign = useCallback(
    (name: string, catId: string | null) => {
      const nextAssignments = { ...categoriesDoc.assignments };
      if (catId === null) delete nextAssignments[name];
      else nextAssignments[name] = catId;
      setSaving(true);
      setSaveError(null);
      onSaveCategories({ categories: categoriesDoc.categories, assignments: nextAssignments })
        .catch((e) => setSaveError(e instanceof Error ? e.message : String(e)))
        .finally(() => setSaving(false));
    },
    [categoriesDoc, onSaveCategories],
  );

  /** 递归渲染分组（分类模式下为树，子组缩进） */
  function renderGroup(g: SkillGroup) {
    const isCollapsed = !!collapsed[g.key];
    const hasKids = g.children.length > 0;
    return (
      <div key={g.key} style={g.depth ? { marginLeft: g.depth * 18 } : undefined}>
        <button
          className={`mb-1 flex w-full items-baseline gap-2 border-b pb-1 text-left ${
            g.inbox ? "border-neon-amber/30" : "border-ink-700/60"
          }`}
          onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}
          title={isCollapsed ? "展开该组" : "折叠该组"}
        >
          <span className="w-3 shrink-0 text-[10px] text-mist-500">{isCollapsed ? "▸" : "▾"}</span>
          <span className={`font-mono text-[12px] font-bold ${g.textClass}`}>
            {g.icon} {g.label}
          </span>
          <span className="font-mono text-[11px] text-mist-500">
            {hasKids ? `${g.subtreeCount} 个 · ${fmtNum(g.subtreeTokens)} tok（含子级）` : `${g.items.length} 个 · ${fmtNum(g.subtreeTokens)} tok`}
          </span>
          {g.inbox && g.items.length > 0 && (
            <span className="rounded border border-neon-amber/40 bg-neon-amber/10 px-1.5 py-px font-mono text-[10px] text-neon-amber">
              待归类
            </span>
          )}
          {hasKids && (
            <span className="rounded border border-ink-600 bg-ink-800/60 px-1.5 py-px font-mono text-[10px] text-mist-500">
              {g.children.length} 个子组
            </span>
          )}
        </button>
        {!isCollapsed && (
          <div className="space-y-1">
            {g.inbox && g.items.length === 0 && (
              <div className="px-2.5 py-1.5 text-[11px] text-mist-500">🎉 全部技能都已归类，没有待处理项。</div>
            )}
            {sortItems(g.items).map((s) => (
              <SkillRow
                key={s.name}
                s={s}
                effCat={effCat(s.name)}
                maxShare={maxShare}
                tree={tree}
                saving={saving}
                onAssign={assign}
              />
            ))}
            {g.children.map(renderGroup)}
          </div>
        )}
      </div>
    );
  }

  const copyText = [
    `context: ${ctx.model ?? "?"} · window ${ctx.contextLength ?? "?"} · used ${ctx.usedTokens} (${ctx.usedPercent ?? "?"}%) · anchor ${ctx.anchor}`,
    ...ctx.categories.map(
      (c) => `  ${c.label}: ${c.tokens} tok (${c.percent ?? "?"}%) · ${c.chars} chars`,
    ),
    `  Autocompact: N/A (wire 无对应字段)`,
    hasWindow ? `  Free space: ${ctx.freeTokens} tok (${ctx.freePercent}%)` : `  Free space: —`,
    `skills (${ctx.skills.length} 注入):`,
    ...ctx.skills.map((s) => {
      const cid = effCat(s.name);
      const catLabel = cid ? (catById.get(cid)?.label ?? cid) : "未分类";
      const srcLabel = s.source ? SOURCE_META[s.source].label : "?";
      const vendorLabel = s.provenance?.vendor ? VENDOR_META[s.provenance.vendor].label : "?";
      return `  [${SCOPE_META[s.scope].label}·${srcLabel}·${vendorLabel}·${catLabel}] ${s.name}${s.placeholder ? " [占位]" : ""}: ${s.tokens} tok · ${s.sharePercent}%`;
    }),
  ].join("\n");

  return (
    <>
    <SectionCard
      id="sec-context"
      tag="derived · /context 式"
      title="上下文占用"
      icon="📊"
      accent="purple"
      defaultOpen
      badges={[
        ...(ctx.model ? [<Badge key="m" accent="cyan">🧠 {ctx.model}</Badge>] : []),
        ...(hasWindow
          ? [<Badge key="w" accent="blue">🪟 {fmtWindow(ctx.contextLength)} 窗口</Badge>]
          : []),
        <Badge
          key="a"
          accent={ctx.anchor === "usage" ? "green" : "amber"}
          title={
            ctx.anchor === "usage"
              ? "总量锚定服务端 usage.prompt_tokens（真值）；分类/份额为校准估算 × 归一化系数"
              : "无 usage 数据，全部为本地校准估算（CJK×0.6 + 其他÷4）"
          }
        >
          {ctx.anchor === "usage" ? "⚓ 服务端真值锚定" : "🧮 本地估算"}
        </Badge>,
      ]}
      copyText={copyText}
      banner={
        <div className="rounded-lg border border-neon-purple/25 bg-neon-purple/[0.04] px-3.5 py-2 text-[12px] leading-relaxed text-mist-300">
          📐 口径说明：总量取服务端 <code className="text-neon-green">usage.prompt_tokens</code>{" "}
          真值；分类与份额按<b>校准估算</b>（CJK×0.6 + 其他÷4）再整体归一化到该真值。
          与 qodercli <code>/context</code> 面板的差异见{" "}
          <code className="text-neon-cyan">docs/context-panel-validation.md</code>。
        </div>
      }
    >
      <div className="space-y-4">
        {/* Hero：已用 % + 堆叠窗口条 */}
        <div className="rounded-xl border border-ink-700 bg-gradient-to-br from-ink-850 via-ink-900 to-ink-950 p-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-4xl font-black text-neon-cyan glow-cyan">
              {ctx.usedPercent !== null ? `${ctx.usedPercent}%` : "—"}
            </span>
            <span className="font-mono text-[13px] text-mist-300">
              {fmtNum(ctx.usedTokens)} tokens 已用
              {hasWindow && (
                <span className="text-mist-500">
                  {" "}· {fmtWindow(ctx.contextLength)} 窗口 · 剩余 {fmtNum(ctx.freeTokens)}
                </span>
              )}
            </span>
            {ctx.promptTokens === null && (
              <span className="text-[11px] text-neon-amber font-mono">（响应缺少 usage，纯估算）</span>
            )}
          </div>
          {/* 堆叠条：四分类 + free */}
          <div className="mt-3 flex h-4 w-full overflow-hidden rounded-full border border-ink-700" title={`已用 ${usedPctOfBar.toFixed(2)}%`}>
            {ctx.categories.map((c) => (
              <div
                key={c.key}
                className={CAT_META[c.key].bar}
                style={{ width: `${(c.tokens / barTotal) * 100}%` }}
                title={`${c.label}: ${fmtNum(c.tokens)} tok (${c.percent ?? "?"}%)`}
              />
            ))}
            {hasWindow && <div className="flex-1 bg-ink-800" title={`Free space: ${fmtNum(ctx.freeTokens)} tok`} />}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-mist-500">
            {ctx.categories.map((c) => (
              <span key={c.key}>
                <i className={`inline-block h-2 w-2 rounded-sm mr-1.5 ${CAT_META[c.key].bar}`} />
                {c.label} {c.percent !== null ? `${c.percent}%` : `${fmtNum(c.tokens)} tok`}
              </span>
            ))}
            {hasWindow && (
              <span>
                <i className="inline-block h-2 w-2 rounded-sm mr-1.5 bg-ink-700" />
                Free {ctx.freePercent}%
              </span>
            )}
          </div>
        </div>

        {/* 分类明细行 */}
        <div className="space-y-1.5">
          {ctx.categories.map((c) => {
            const meta = CAT_META[c.key];
            return (
              <CategoryRow
                key={c.key}
                barPercent={(c.tokens / barTotal) * 100}
                cat={{
                  icon: meta.icon,
                  label: c.label,
                  tokensLabel: `${fmtNum(c.tokens)} tok`,
                  percentLabel: c.percent !== null ? `${c.percent}%` : "—",
                  text: meta.text,
                  bar: meta.bar,
                }}
              />
            );
          })}
          {/* Autocompact：wire 无对应字段，无法验证 */}
          <div title="qodercli /context 面板显示 Autocompact ≈6.9%（预留给自动压缩的缓冲区），但 wire 请求中没有对应字段，无法从日志验证 —— open question">
            <CategoryRow
              barPercent={0}
              dim
              cat={{
                icon: "🗜",
                label: "Autocompact",
                tokensLabel: "N/A",
                percentLabel: "N/A",
                text: "text-mist-500",
                bar: "bg-mist-700",
              }}
            />
          </div>
          {hasWindow && ctx.freeTokens !== null && (
            <CategoryRow
              barPercent={(ctx.freeTokens / barTotal) * 100}
              cat={{
                icon: "🌫",
                label: "Free space",
                tokensLabel: `${fmtNum(ctx.freeTokens)} tok`,
                percentLabel: `${ctx.freePercent}%`,
                text: "text-mist-300",
                bar: "bg-ink-600",
              }}
            />
          )}
        </div>

        {/* Skills 明细（仅注入技能；可按作用域或用户手动分类分组） */}
        {ctx.skills.length > 0 && (
          <div
            className="rounded-lg border border-ink-700 bg-ink-950/40 p-4"
            style={{ "--skill-cols": colTemplate } as CSSProperties}
          >
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[13px] font-bold text-neon-purple">
                🧩 Skills 明细 · {ctx.skills.length} 个注入技能
              </span>
              {placeholderCount > 0 && (
                <Badge accent="red" title="占位技能：注入列表里的纯名字条目，模型无法主动调用，但仍占据注入体积">
                  👻 {placeholderCount} 个占位
                </Badge>
              )}
              {ctx.skillListInstances > 1 && (
                <Badge accent="amber" title="多轮对话中技能列表会随 user 消息重复注入，全部实例计入 Skills 占用">
                  🔁 列表注入 ×{ctx.skillListInstances}
                </Badge>
              )}
              {grouping === "category" && inboxCount > 0 && (
                <Badge accent="amber" title="尚未归类的技能数；切到「按分类」分组可在收件箱里逐个处理">
                  📥 {inboxCount} 个待归类
                </Badge>
              )}

              {/* 分组维度切换 */}
              <span className="ml-auto flex items-center gap-1 font-mono text-[11px] text-mist-500">
                分组
                {(Object.keys(GROUPING_LABEL) as Grouping[]).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGrouping(g)}
                    className={`rounded border px-1.5 py-px ${
                      grouping === g
                        ? "border-neon-cyan/50 bg-neon-cyan/15 text-neon-cyan"
                        : "border-ink-700 text-mist-400 hover:bg-ink-800"
                    }`}
                  >
                    {GROUPING_LABEL[g]}
                  </button>
                ))}
              </span>
              <span className="flex items-center gap-1 font-mono text-[11px] text-mist-500">
                排序
                {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setSortKey(k)}
                    className={`rounded border px-1.5 py-px ${
                      sortKey === k
                        ? "border-neon-purple/50 bg-neon-purple/15 text-neon-purple"
                        : "border-ink-700 text-mist-400 hover:bg-ink-800"
                    }`}
                  >
                    {SORT_LABEL[k]}
                  </button>
                ))}
              </span>
              <button
                onClick={copyTsv}
                className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-2 py-px font-mono text-[11px] text-neon-cyan hover:bg-neon-cyan/20"
                title="按当前分组与排序复制整表（TSV 制表符分隔），可直接粘贴到 Excel / 表格文档"
              >
                {copied ? "✓ 已复制" : "📋 复制表格"}
              </button>
              <button
                onClick={() => setManaging(true)}
                className="rounded border border-neon-purple/40 bg-neon-purple/10 px-2 py-px font-mono text-[11px] text-neon-purple hover:bg-neon-purple/20"
                title="增删改分类（名称 / 颜色 / 排序）"
              >
                🏷 管理分类
              </button>
            </div>

            <div className="mb-3 rounded-md border border-neon-amber/25 bg-neon-amber/[0.04] px-3 py-1.5 text-[11.5px] leading-relaxed text-mist-400">
              ⚠️ 口径差异：qodercli <code>/context</code> Skills 页列出的是<b>全部可调用技能</b>（含标记{" "}
              <code className="text-neon-amber">disable-model-invocation: true</code>{" "}
              的用户手动技能——它们零 token 成本、不进 wire）；此处只列<b>实际注入</b>的技能，份额分母为注入列表。
              {ctx.skillListInstances > 1 && `明细取最大的一份注入实例（共 ${ctx.skillListInstances} 份，占用全部计入）。`}
            </div>

            {grouping === "scope" ? (
              <div className="mb-3 rounded-md border border-ink-700 bg-ink-900/40 px-3 py-1.5 text-[11.5px] leading-relaxed text-mist-400">
                🔍 作用域分组为<b>解析期扫盘反推</b>（wire 注入列表不携带作用域字段）：Project 来自{" "}
                <code className="text-neon-cyan">server/skill-roots.json</code> 配置的 qodercli
                发起目录下的 <code>.qoder / .agents / .claude</code> 各 <code>skills</code>{" "}
                目录（含符号链接，与 /context 同规则 project &gt;
                user 取先命中者）；User 来自用户级技能目录；Plugin 来自插件注册表
                （<code className="text-neon-cyan">installed_plugins_v2.json</code>）+ 缓存目录扫描，
                以 <code>pluginName:skillName</code> 命名空间索引；查不到的名字归为 Built-in（残余启发式）。
                {ctx.skills.every((s) => s.scope === "unknown") && "当前扫盘不可用，全部标记为未知。"}
              </div>
            ) : (
              <div className="mb-3 rounded-md border border-ink-700 bg-ink-900/40 px-3 py-1.5 text-[11.5px] leading-relaxed text-mist-400">
                🏷 分类是<b>你手动维护</b>的「这个技能是干什么用的」，存于{" "}
                <code className="text-neon-cyan">server/skill-categories.json</code>（gitignore）。按技能名索引，
                <b>跨日志生效</b>——切到任意日志，同名技能自动套用同一分组；没归类的落「未分类」收件箱，方便快速处理新技能。
              </div>
            )}

            {saveError && (
              <div className="mb-3 rounded-md border border-neon-red/40 bg-neon-red/5 px-3 py-1.5 text-[11.5px] text-neon-red">
                保存分类失败：{saveError}
              </div>
            )}

            <div
              className="mb-1 grid select-none items-center gap-2 px-2.5 font-mono text-[10.5px] text-mist-500"
              style={GRID_COLS_STYLE}
            >
              {COLS.map((c, i) => (
                <span key={c.key} className={`relative pr-2 ${c.align === "right" ? "text-right" : ""}`}>
                  {c.label}
                  <span
                    onPointerDown={startResize(i)}
                    onDoubleClick={() => resetCol(i)}
                    className="absolute right-0 top-1/2 h-4 w-1.5 -translate-y-1/2 cursor-col-resize rounded bg-ink-600 hover:bg-neon-cyan/70"
                    title={
                      c.flex
                        ? "拖拽设置最小宽（该列自动伸展填充剩余宽度）· 双击重置"
                        : "拖拽调整列宽 · 双击重置该列"
                    }
                  />
                </span>
              ))}
            </div>
            <div className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">{groups.map(renderGroup)}</div>
          </div>
        )}
      </div>
    </SectionCard>
    {managing && (
      <CategoryManager
        doc={{ categories: sortedCats, assignments: categoriesDoc.assignments }}
        onSave={onSaveCategories}
        onClose={() => setManaging(false)}
      />
    )}
    </>
  );
}
