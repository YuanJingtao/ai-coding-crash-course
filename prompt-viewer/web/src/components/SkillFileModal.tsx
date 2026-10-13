import { useEffect, useState } from "react";
import type { SkillScope } from "../types";

interface FileEntry {
  rel: string;
  size: number;
}
interface Listing {
  dir: string;
  scope: SkillScope;
  files: FileEntry[];
}

const SCOPE_LABEL: Record<SkillScope, string> = {
  project: "📁 Project",
  user: "👤 User",
  builtin: "⚙️ Built-in",
  unknown: "❔ 未知",
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 技能文件预览弹窗：列出扫盘索引目录下的文件，默认展示 SKILL.md 原文 */
export function SkillFileModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    setListing(null);
    setListError(null);
    setActive(null);
    fetch(`/api/skills/${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j.ok) {
          setListError(j.error ?? "加载失败");
          return;
        }
        setListing(j);
        const skillMd = j.files.find((f: FileEntry) => f.rel === "SKILL.md");
        setActive(skillMd ? skillMd.rel : (j.files[0]?.rel ?? null));
      })
      .catch((e) => alive && setListError(String(e)));
    return () => {
      alive = false;
    };
  }, [name]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setContent(null);
    setFileError(null);
    fetch(`/api/skills/${encodeURIComponent(name)}/file?rel=${encodeURIComponent(active)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j.ok) setFileError(j.error ?? "加载失败");
        else setContent(j.content);
      })
      .catch((e) => alive && setFileError(String(e)));
    return () => {
      alive = false;
    };
  }, [name, active]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div
        className="flex h-[82vh] w-[min(1100px,94vw)] flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-ink-700 px-4 py-2.5">
          <span className="font-mono text-[13px] font-bold text-neon-purple">📄 {name}</span>
          {listing && (
            <span className="rounded border border-ink-600 bg-ink-800 px-1.5 py-px font-mono text-[10.5px] text-mist-400">
              {SCOPE_LABEL[listing.scope]}
            </span>
          )}
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-mist-500" title={listing?.dir}>
            {listing?.dir ?? ""}
          </code>
          <button
            className="shrink-0 rounded px-2 py-0.5 font-mono text-[13px] text-mist-400 hover:bg-ink-800 hover:text-mist-100"
            onClick={onClose}
            title="关闭（Esc）"
          >
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-64 shrink-0 overflow-y-auto border-r border-ink-700 p-2">
            {listError && <div className="p-2 text-[12px] text-neon-red">{listError}</div>}
            {!listError && !listing && <div className="p-2 text-[12px] text-mist-500">加载文件列表…</div>}
            {listing?.files.map((f) => (
              <button
                key={f.rel}
                onClick={() => setActive(f.rel)}
                className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left font-mono text-[11.5px] ${
                  active === f.rel ? "bg-neon-purple/15 text-neon-purple" : "text-mist-300 hover:bg-ink-800"
                }`}
                title={f.rel}
              >
                <span className="min-w-0 flex-1 truncate">{f.rel}</span>
                <span className="shrink-0 text-[10px] text-mist-500">{fmtSize(f.size)}</span>
              </button>
            ))}
            {listing && listing.files.length === 0 && (
              <div className="p-2 text-[12px] text-mist-500">目录为空</div>
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-auto bg-ink-950/60 p-4">
            {fileError && <div className="text-[12px] text-neon-red">{fileError}</div>}
            {!fileError && content === null && active && (
              <div className="text-[12px] text-mist-500">加载 {active} …</div>
            )}
            {!active && !fileError && listing && (
              <div className="text-[12px] text-mist-500">无可预览的文件</div>
            )}
            {content !== null && (
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-mist-200">
                {content}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
