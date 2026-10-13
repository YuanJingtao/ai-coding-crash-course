import { useEffect, useMemo, useState } from "react";
import type { SkillScope } from "../types";
import { skillFileHref } from "../routes";
import { Markdown } from "./Markdown";

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
  plugin: "🔌 Plugin",
  builtin: "⚙️ Built-in",
  unknown: "❔ 未知",
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** .md/.mdx 默认渲染为富文本（可切原文）；其余文件按纯文本展示 */
const isMarkdown = (rel: string) => /\.mdx?$/i.test(rel);

/**
 * 拆出 YAML frontmatter（SKILL.md 必有）。不拆的话 react-markdown 会把
 * `---` 当 setext 下划线，整段 frontmatter 渲染成一个巨型标题。
 * 只做展示级的最小解析：键行 + 缩进续行并入上一个键的值（块标量/折行描述）。
 */
function splitFrontmatter(text: string): { meta: [string, string][]; body: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: [], body: text };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return { meta: [], body: text };
  const meta: [string, string][] = [];
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) {
      meta.push([m[1], m[2].trim()]);
      continue;
    }
    if (meta.length > 0 && /^\s/.test(line)) {
      meta[meta.length - 1][1] = `${meta[meta.length - 1][1]} ${line.trim()}`.trim();
    }
  }
  return { meta, body: lines.slice(end + 1).join("\n") };
}

/**
 * 技能文件页（`#/skill/:name`，从 Skills 明细新标签页打开）：
 * 左侧文件树、右侧内容，整页高度独立于日志查看器，便于长时间阅读 SKILL.md。
 * 当前文件写回 hash（replaceState，不产生历史记录），故地址栏可直接复制分享。
 */
export function SkillFilePage({ name, initialRel }: { name: string; initialRel: string | null }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(initialRel);
  const [content, setContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    document.title = `${name} · 技能文件`;
    return () => {
      document.title = "Prompt Viewer · Qoder Wire 日志";
    };
  }, [name]);

  useEffect(() => {
    let alive = true;
    setListing(null);
    setListError(null);
    fetch(`/api/skills/${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j.ok) {
          setListError(j.error ?? "加载失败");
          return;
        }
        setListing(j);
        // 深链的 rel 优先；失效（文件已删）则回落 SKILL.md，再回落首个文件
        setActive((prev) => {
          const files = j.files as FileEntry[];
          const wanted = prev ?? "SKILL.md";
          if (files.some((f) => f.rel === wanted)) return wanted;
          return files.find((f) => f.rel === "SKILL.md")?.rel ?? files[0]?.rel ?? null;
        });
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

  useEffect(() => {
    if (!active) return;
    window.history.replaceState(null, "", skillFileHref(name, active));
  }, [name, active]);

  const activeEntry = listing?.files.find((f) => f.rel === active) ?? null;
  const rendered = useMemo(
    () => (content !== null && isMarkdown(active ?? "") ? splitFrontmatter(content) : null),
    [content, active],
  );

  return (
    <div className="flex h-screen flex-col bg-ink-950">
      <header className="flex shrink-0 items-center gap-3 border-b border-ink-700 bg-ink-900/60 px-4 py-2.5">
        <a
          href="#/"
          className="shrink-0 rounded border border-ink-600 px-2 py-0.5 font-mono text-[11px] text-mist-400 hover:bg-ink-800 hover:text-neon-cyan"
          title="回到日志查看器（当前标签页）"
        >
          ← 日志
        </a>
        <span className="shrink-0 font-mono text-[14px] font-bold text-neon-purple">🧩 {name}</span>
        {listing && (
          <span className="shrink-0 rounded border border-ink-600 bg-ink-800 px-1.5 py-px font-mono text-[10.5px] text-mist-400">
            {SCOPE_LABEL[listing.scope]}
          </span>
        )}
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-mist-500"
          title={listing?.dir ? `${listing.dir}${active ? `/${active}` : ""}` : ""}
        >
          {listing?.dir ?? ""}
        </code>
        {content !== null && isMarkdown(active ?? "") && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-mist-500">
            {[
              { label: "渲染", raw: false },
              { label: "原文", raw: true },
            ].map((m) => (
              <button
                key={m.label}
                onClick={() => setShowRaw(m.raw)}
                className={`rounded border px-1.5 py-px ${
                  showRaw === m.raw
                    ? "border-neon-cyan/50 bg-neon-cyan/15 text-neon-cyan"
                    : "border-ink-700 text-mist-400 hover:bg-ink-800"
                }`}
              >
                {m.label}
              </button>
            ))}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-ink-700 bg-ink-900/30 p-2">
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
          {listing && listing.files.length === 0 && <div className="p-2 text-[12px] text-mist-500">目录为空</div>}
        </aside>

        <main className="min-w-0 flex-1 overflow-auto">
          <div className="flex items-baseline gap-3 border-b border-ink-800 px-6 py-2">
            <code className="min-w-0 truncate font-mono text-[12px] text-neon-cyan">{active ?? ""}</code>
            {activeEntry && (
              <span className="shrink-0 font-mono text-[10.5px] text-mist-500">{fmtSize(activeEntry.size)}</span>
            )}
          </div>
          <div className="px-6 py-5">
            {fileError && <div className="text-[12px] text-neon-red">{fileError}</div>}
            {!fileError && content === null && active && (
              <div className="font-mono text-[12px] text-mist-500">加载 {active} …</div>
            )}
            {!active && !fileError && listing && (
              <div className="font-mono text-[12px] text-mist-500">无可预览的文件</div>
            )}
            {content !== null &&
              (rendered && !showRaw ? (
                <>
                  {rendered.meta.length > 0 && (
                    <dl className="mb-5 space-y-1 rounded-lg border border-ink-700 bg-ink-900/40 px-4 py-3">
                      {rendered.meta.map(([k, v]) => (
                        <div key={k} className="flex gap-2 font-mono text-[12px] leading-relaxed">
                          <dt className="shrink-0 text-neon-cyan">{k}</dt>
                          <dd className="min-w-0 break-words text-mist-300">{v || "—"}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <Markdown>{rendered.body}</Markdown>
                </>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-mist-200">
                  {content}
                </pre>
              ))}
          </div>
        </main>
      </div>
    </div>
  );
}
