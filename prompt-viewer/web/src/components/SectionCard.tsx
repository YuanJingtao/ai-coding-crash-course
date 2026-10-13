import { useState, type ReactNode } from "react";

export type Accent = "cyan" | "amber" | "purple" | "green" | "blue" | "red";

const ACCENT: Record<Accent, { border: string; text: string; bg: string }> = {
  cyan: { border: "border-neon-cyan/40", text: "text-neon-cyan", bg: "bg-neon-cyan/10" },
  amber: { border: "border-neon-amber/40", text: "text-neon-amber", bg: "bg-neon-amber/10" },
  purple: { border: "border-neon-purple/40", text: "text-neon-purple", bg: "bg-neon-purple/10" },
  green: { border: "border-neon-green/40", text: "text-neon-green", bg: "bg-neon-green/10" },
  blue: { border: "border-neon-blue/40", text: "text-neon-blue", bg: "bg-neon-blue/10" },
  red: { border: "border-neon-red/40", text: "text-neon-red", bg: "bg-neon-red/10" },
};

export function Badge({
  children,
  accent = "cyan",
  title,
}: {
  children: ReactNode;
  accent?: Accent;
  title?: string;
}) {
  const a = ACCENT[accent];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${a.bg} ${a.text} border ${a.border}`}
    >
      {children}
    </span>
  );
}

interface SectionCardProps {
  id: string;
  /** wire 标签名，如 <headers> */
  tag: string;
  title: string;
  icon: string;
  accent?: Accent;
  badges?: ReactNode[];
  /** 摘要行右侧统计文本 */
  statsText?: string;
  defaultOpen?: boolean;
  /** 提供后在头部显示复制按钮 */
  copyText?: string;
  children: ReactNode;
  /** 头部下方、内容上方的附加区域（如提示条） */
  banner?: ReactNode;
}

export function SectionCard({
  id,
  tag,
  title,
  icon,
  accent = "cyan",
  badges = [],
  statsText,
  defaultOpen = false,
  copyText,
  children,
  banner,
}: SectionCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const a = ACCENT[accent];

  const doCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 忽略剪贴板失败 */
    }
  };

  return (
    <section
      id={id}
      className={`rounded-xl border border-ink-700 bg-ink-900/80 backdrop-blur-sm overflow-hidden scroll-mt-4 transition-colors hover:border-ink-600`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left group"
        aria-expanded={open}
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${a.bg} text-base`}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-mist-100 text-sm">{title}</span>
            <code className={`text-[11px] font-mono ${a.text} opacity-70`}>{tag}</code>
            {badges.map((b, i) => (
              <span key={i}>{b}</span>
            ))}
          </span>
        </span>
        {statsText && (
          <span className="hidden sm:block text-[11px] text-mist-500 font-mono shrink-0">
            {statsText}
          </span>
        )}
        {copyText && open && (
          <span
            role="button"
            tabIndex={0}
            onClick={doCopy}
            onKeyDown={(e) => e.key === "Enter" && doCopy(e as unknown as React.MouseEvent)}
            className="shrink-0 rounded-md border border-ink-600 px-2 py-0.5 text-[11px] text-mist-500 hover:text-neon-cyan hover:border-neon-cyan/40 transition-colors"
            title="复制本段原始内容"
          >
            {copied ? "✓ 已复制" : "复制"}
          </span>
        )}
        <span
          className={`shrink-0 text-mist-500 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        >
          ▶
        </span>
      </button>
      {open && (
        <div className="border-t border-ink-700/60">
          {banner && <div className="px-4 pt-3">{banner}</div>}
          <div className="p-4">{children}</div>
        </div>
      )}
    </section>
  );
}
