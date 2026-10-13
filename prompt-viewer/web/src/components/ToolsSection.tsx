import { useMemo, useState } from "react";
import type { ToolEntry } from "../types";
import { fmtNum } from "../format";
import { Markdown } from "./Markdown";

/**
 * <tools> 段：工具网格。每个 `### 工具名` 解析为一张卡片，
 * 支持按名字过滤，点击展开完整定义。
 */
export function ToolsSection({ entries }: { entries: ToolEntry[] }) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (t) => t.name.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q),
    );
  }, [entries, filter]);
  const shownTokens = shown.reduce((acc, t) => acc + t.tokens, 0);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="🔍 按名字或描述过滤工具…"
          className="w-64 rounded-md border border-ink-600 bg-ink-950 px-3 py-1.5 text-[12.5px] text-mist-100 placeholder:text-mist-700 outline-none focus:border-neon-cyan/50 transition-colors"
        />
        <span className="text-[11px] text-mist-500 font-mono">
          共 {entries.length} 个工具 · 显示 {shown.length} · Σ{" "}
          <span className="text-neon-blue">{fmtNum(shownTokens)} tok</span>
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {shown.map((t) => {
          const isOpen = expanded === t.name;
          return (
            <div
              key={t.name}
              className={`rounded-lg border transition-colors ${
                isOpen
                  ? "border-neon-cyan/50 md:col-span-2 xl:col-span-3 glow-cyan"
                  : "border-ink-700 hover:border-ink-600"
              } bg-ink-850/60`}
            >
              <button
                onClick={() => setExpanded(isOpen ? null : t.name)}
                className="w-full text-left px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <code className="font-mono text-[13px] font-bold text-neon-cyan">
                    {t.name}
                  </code>
                  <span
                    className="shrink-0 text-[10.5px] text-mist-700 font-mono"
                    title={`校准估算 ${fmtNum(t.estTokens)} tok × 归一化系数；占当前显示工具 ${
                      shownTokens > 0 ? ((t.tokens / shownTokens) * 100).toFixed(1) : "0"
                    }%`}
                  >
                    <span className="text-neon-blue">{fmtNum(t.tokens)} tok</span> · {fmtNum(t.stats.lines)} 行
                  </span>
                </div>
                {!isOpen && (
                  <p className="mt-1 text-[11.5px] leading-relaxed text-mist-500 line-clamp-2">
                    {t.summary}
                  </p>
                )}
              </button>
              {isOpen && (
                <div className="border-t border-ink-700 px-4 py-3 max-h-[60vh] overflow-y-auto">
                  <Markdown>{t.markdown}</Markdown>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {shown.length === 0 && (
        <div className="rounded-lg border border-dashed border-ink-600 p-6 text-center text-mist-500 text-sm">
          没有匹配「{filter}」的工具
        </div>
      )}
    </div>
  );
}
