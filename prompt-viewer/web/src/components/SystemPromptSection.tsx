import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";

interface Heading {
  id: string;
  text: string;
  level: number;
}

/**
 * <system-prompt> 段：完整 markdown 渲染 + 内部标题 mini-TOC。
 * TOC 通过渲染后的 DOM 扫描生成（对 StrictMode 双渲染稳定），
 * 并顺带给 h1/h2 注入锚点 id。
 */
export function SystemPromptSection({ markdown }: { markdown: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nodes = el.querySelectorAll("h1, h2");
    const hs: Heading[] = [];
    nodes.forEach((n, i) => {
      const id = `sp-h-${i}`;
      n.id = id;
      hs.push({ id, text: n.textContent ?? "", level: n.tagName === "H1" ? 1 : 2 });
    });
    setHeadings(hs);
  }, [markdown]);

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      {headings.length > 0 && (
        <nav className="lg:w-56 shrink-0">
          <div className="lg:sticky lg:top-4 rounded-lg border border-ink-700 bg-ink-850/60 p-3 max-h-80 lg:max-h-[70vh] overflow-y-auto">
            <div className="text-[10.5px] font-semibold text-mist-500 tracking-widest mb-2">
              SYSTEM PROMPT 目录
            </div>
            <ul className="space-y-0.5">
              {headings.map((h) => (
                <li key={h.id}>
                  <a
                    href={`#${h.id}`}
                    className={`block rounded px-2 py-1 text-[11.5px] leading-snug hover:bg-ink-800 hover:text-neon-cyan transition-colors ${
                      h.level === 1 ? "text-mist-300 font-medium" : "text-mist-500 pl-4"
                    }`}
                  >
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      )}
      <div ref={ref} className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950/50 p-4">
        <Markdown>{markdown}</Markdown>
      </div>
    </div>
  );
}
