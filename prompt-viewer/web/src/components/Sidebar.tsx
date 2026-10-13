import type { LogListItem, ParsedLog } from "../types";
import { fmtBytes, fmtTime } from "../format";

export interface TocEntry {
  id: string;
  label: string;
  icon: string;
}

interface Props {
  logs: LogListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  toc: TocEntry[];
  log: ParsedLog | null;
  /** 是否在列表中显示辅助请求（标题生成 / 输入建议），默认关 */
  showAux: boolean;
  onToggleShowAux: () => void;
}

export function Sidebar({ logs, selectedId, onSelect, toc, log, showAux, onToggleShowAux }: Props) {
  // 分类由后端给出（kind），前端只做展示过滤，切换无需重新请求
  const auxCount = logs.filter((l) => l.kind === "auxiliary").length;
  const visible = showAux ? logs : logs.filter((l) => l.kind !== "auxiliary");
  return (
    <aside className="w-72 shrink-0 border-r border-ink-700/70 bg-ink-900/60 backdrop-blur-md flex flex-col h-screen sticky top-0">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-ink-700/70">
        <div className="flex items-center gap-2">
          <span className="text-xl">⚡</span>
          <div>
            <div className="font-bold text-mist-100 text-sm tracking-wide">Prompt Viewer</div>
            <div className="text-[11px] text-mist-500">Qoder Wire 日志可视化</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
        {/* 本页导航 */}
        {log && (
          <nav>
            <div className="px-1 pb-1.5 text-[11px] font-semibold text-mist-500 tracking-widest">
              本页导航
            </div>
            <ul className="space-y-0.5">
              {toc.map((t) => (
                <li key={t.id}>
                  <a
                    href={`#${t.id}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-mist-300 hover:bg-ink-800 hover:text-neon-cyan transition-colors"
                  >
                    <span className="text-xs w-4 text-center">{t.icon}</span>
                    {t.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {/* 日志文件 */}
        <nav>
          <div className="px-1 pb-1.5 flex items-center justify-between gap-1">
            <span className="text-[11px] font-semibold text-mist-500 tracking-widest">
              日志文件 · {visible.length}
            </span>
            {auxCount > 0 && (
              <button
                onClick={onToggleShowAux}
                title={
                  showAux
                    ? "隐藏辅助请求（标题生成 / 输入建议）"
                    : `显示 ${auxCount} 条辅助请求（标题生成 / 输入建议）`
                }
                className={`rounded border px-1.5 py-px text-[10px] transition-colors ${
                  showAux
                    ? "border-neon-amber/30 bg-neon-amber/10 text-neon-amber"
                    : "border-transparent bg-ink-800 text-mist-500 hover:text-mist-300"
                }`}
              >
                辅助 · {auxCount}
              </button>
            )}
          </div>
          <ul className="space-y-0.5">
            {visible.map((l) => {
              const active = l.id === selectedId;
              const aux = l.kind === "auxiliary";
              return (
                <li key={l.id}>
                  <button
                    onClick={() => onSelect(l.id)}
                    className={`w-full text-left rounded-md px-2 py-1.5 transition-colors ${
                      active
                        ? "bg-neon-cyan/10 border border-neon-cyan/30 glow-cyan"
                        : "border border-transparent hover:bg-ink-800"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span
                        className={`font-mono text-[11.5px] ${active ? "text-neon-cyan" : "text-mist-300"}`}
                      >
                        {fmtTime(l.timestamp)}
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        {aux && (
                          <span className="rounded border border-neon-amber/25 bg-neon-amber/10 px-1.5 py-px text-[10px] text-neon-amber">
                            {l.auxTask ?? "辅助"}
                          </span>
                        )}
                        {l.agent && (
                          <span className="rounded bg-ink-700 px-1.5 py-px text-[10px] text-mist-500 uppercase">
                            {l.agent}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-mist-700 font-mono">
                      <span className="truncate">{l.id.slice(0, 24)}…</span>
                      <span className="shrink-0">{fmtBytes(l.size)}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      <div className="px-4 py-3 border-t border-ink-700/70 text-[10.5px] text-mist-700 font-mono">
        request-logger/logs · 只读
      </div>
    </aside>
  );
}
