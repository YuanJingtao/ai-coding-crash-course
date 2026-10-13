import { useMemo, useState } from "react";
import type { MessageBlock, ParsedMessage, SkillEntry } from "../types";
import { estTokens, fmtBytes, fmtNum } from "../format";
import { Markdown } from "./Markdown";

const CACHE_MARKER = /^<!--\s*cache_control breakpoint\s*-->$/;

type SkillMode = "all" | "full" | "placeholder";

/** 技能列表注入的结构化渲染：完整/占位筛选 + 文本过滤 + token 估算 */
function SkillsTable({ skills }: { skills: SkillEntry[] }) {
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<SkillMode>("all");

  const fullCount = skills.filter((s) => !s.placeholder).length;
  const placeholderCount = skills.length - fullCount;
  const totalChars = skills.reduce((acc, s) => acc + s.chars, 0);
  const placeholderChars = skills.reduce((acc, s) => acc + (s.placeholder ? s.chars : 0), 0);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return skills.filter((s) => {
      if (mode === "full" && s.placeholder) return false;
      if (mode === "placeholder" && !s.placeholder) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q);
    });
  }, [skills, filter, mode]);

  const modes: { key: SkillMode; label: string }[] = [
    { key: "all", label: `全部 ${skills.length}` },
    { key: "full", label: `✅ 完整 ${fullCount}` },
    { key: "placeholder", label: `👻 占位 ${placeholderCount}` },
  ];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* 完整/占位分段筛选 */}
        <div className="flex overflow-hidden rounded-md border border-ink-600">
          {modes.map((m) => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={`px-2.5 py-1 text-[11.5px] font-mono transition-colors ${
                mode === m.key
                  ? m.key === "placeholder"
                    ? "bg-neon-red/15 text-neon-red"
                    : "bg-neon-purple/15 text-neon-purple"
                  : "bg-ink-950 text-mist-500 hover:text-mist-300"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="🔍 按名字或描述过滤技能…"
          className="w-56 rounded-md border border-ink-600 bg-ink-950 px-2.5 py-1 text-[12px] text-mist-100 placeholder:text-mist-700 outline-none focus:border-neon-purple/50 transition-colors"
        />
        <span className="text-[11px] text-mist-500 font-mono">显示 {shown.length}</span>
      </div>
      {/* token 统计：整份注入的估算成本，占位部分 = 白花 */}
      <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-ink-700 bg-ink-900/60 px-3 py-1.5 text-[11px] font-mono text-mist-500">
        <span>
          🧮 技能列表注入 <b className="text-mist-300">{estTokens(totalChars)}</b>
          <span className="text-mist-700">（{fmtBytes(totalChars)}）</span>
        </span>
        {placeholderCount > 0 && (
          <span title="纯名字条目 = 占位技能（模型无法主动调用），但仍占据注入体积">
            其中占位 {placeholderCount} 个占 <b className="text-neon-red">{estTokens(placeholderChars)}</b>
            <span className="text-mist-700">
              {" "}· {Math.round((placeholderChars / Math.max(totalChars, 1)) * 100)}%
            </span>
          </span>
        )}
      </div>
      <div className="space-y-1">
        {shown.map((s) => (
          <div
            key={s.name}
            className={`rounded-md border px-3 py-2 ${
              s.placeholder ? "border-ink-700/60 bg-ink-900/40 opacity-70" : "border-ink-700 bg-ink-850/60"
            }`}
          >
            <div className="flex items-center gap-2">
              <code className={`font-mono text-[12.5px] font-bold ${s.placeholder ? "text-mist-500" : "text-neon-purple"}`}>
                {s.name}
              </code>
              {s.placeholder && (
                <span className="rounded border border-neon-red/40 bg-neon-red/10 px-1.5 py-px text-[10px] font-bold text-neon-red" title="Placeholder Skill：仅注入名字，模型无法主动调用">
                  占位
                </span>
              )}
              <span className="ml-auto shrink-0 text-[10px] text-mist-700 font-mono">{estTokens(s.chars)}</span>
            </div>
            {s.description ? (
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-mist-500 whitespace-pre-wrap">
                {s.description}
              </p>
            ) : (
              <p className="mt-0.5 text-[11px] text-mist-700">无描述 —— 占位技能，仅保留名字注入</p>
            )}
          </div>
        ))}
        {shown.length === 0 && (
          <div className="rounded-md border border-dashed border-ink-600 p-4 text-center text-mist-500 text-[12px]">
            没有匹配的技能
          </div>
        )}
      </div>
    </div>
  );
}

/** 系统注入 callout：琥珀色、默认折叠、首行摘要；技能列表注入额外给出结构化视图 */
function ReminderCallout({ block, n }: { block: Extract<MessageBlock, { type: "system-reminder" }>; n: number }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const isSkills = block.skills !== null;
  return (
    <div className={`rounded-lg border overflow-hidden ${isSkills ? "border-neon-purple/30 bg-neon-purple/[0.04]" : "border-neon-amber/30 bg-neon-amber/[0.04]"}`}>
      <button
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors ${isSkills ? "hover:bg-neon-purple/[0.05]" : "hover:bg-neon-amber/[0.05]"}`}
        aria-expanded={open}
      >
        <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[10.5px] font-bold ${isSkills ? "bg-neon-purple/15 border-neon-purple/40 text-neon-purple" : "bg-neon-amber/15 border-neon-amber/40 text-neon-amber"}`}>
          {isSkills ? `🧩 系统注入 #${n} · 技能列表` : `📌 系统注入 #${n}`}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-mist-300 font-medium">
          {isSkills
            ? `${block.skills!.length} 个技能已注入 · ${block.skills!.filter((s) => s.placeholder).length} 个占位`
            : block.summary}
        </span>
        <span className="shrink-0 text-[10.5px] text-mist-700 font-mono">
          {fmtNum(block.stats.lines)} 行 · {fmtBytes(block.stats.chars)}
        </span>
        <span className={`shrink-0 text-[10px] transition-transform ${isSkills ? "text-neon-purple/60" : "text-neon-amber/60"} ${open ? "rotate-90" : ""}`}>
          ▶
        </span>
      </button>
      {open && (
        <div className="border-t border-ink-700 px-4 py-3 max-h-[32rem] overflow-y-auto bg-ink-950/40">
          {isSkills && (
            <div className="mb-2.5 flex justify-end">
              <button
                onClick={() => setRaw(!raw)}
                className="rounded-md border border-ink-600 px-2 py-0.5 text-[10.5px] text-mist-500 hover:text-mist-300 hover:border-ink-500 transition-colors"
              >
                {raw ? "结构化视图" : "查看原文"}
              </button>
            </div>
          )}
          {isSkills && !raw ? <SkillsTable skills={block.skills!} /> : <Markdown>{block.markdown}</Markdown>}
        </div>
      )}
    </div>
  );
}

/** 用户真实输入气泡：页面的叙事高潮 */
function UtteranceBubble({ block }: { block: Extract<MessageBlock, { type: "user-text" }> }) {
  const lines = block.markdown.split("\n");
  const pure: (string | { marker: string })[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) pure.push(t);
    buf = [];
  };
  for (const l of lines) {
    if (CACHE_MARKER.test(l.trim())) {
      flush();
      pure.push({ marker: "cache_control breakpoint" });
    } else buf.push(l);
  }
  flush();

  return (
    <div className="rounded-xl border border-neon-green/40 bg-gradient-to-br from-neon-green/[0.07] to-transparent p-4 glow-green">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-md bg-neon-green/15 border border-neon-green/40 px-2 py-0.5 text-[10.5px] font-bold text-neon-green">
          💬 用户真实输入
        </span>
        <span className="text-[10.5px] text-mist-700 font-mono">
          这才是用户亲手敲下的内容
        </span>
      </div>
      <div className="space-y-2">
        {pure.map((p, i) =>
          typeof p === "string" ? (
            <div
              key={i}
              className="text-neon-green text-2xl font-bold font-mono tracking-wide text-center py-2 select-all"
            >
              {p}
            </div>
          ) : (
            <div key={i} className="flex items-center gap-2 justify-center">
              <span className="h-px flex-1 bg-neon-green/20" />
              <span className="rounded-full border border-neon-cyan/30 bg-neon-cyan/10 px-2.5 py-0.5 text-[10px] font-mono text-neon-cyan" title="prompt 缓存边界标记">
                ⚡ {p.marker}
              </span>
              <span className="h-px flex-1 bg-neon-green/20" />
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export function MessagesSection({ messages }: { messages: ParsedMessage[] }) {
  return (
    <div className="space-y-5">
      {messages.map((msg) => {
        const utteranceChars = msg.blocks
          .filter((b) => b.type === "user-text")
          .reduce(
            (acc, b) =>
              acc +
              b.markdown.split("\n").filter((l) => !CACHE_MARKER.test(l.trim())).join("\n").trim().length,
            0,
          );
        let reminderNo = 0;
        return (
          <div key={msg.index} className="rounded-lg border border-ink-700 bg-ink-950/40 p-4">
            {/* 消息头 */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-neon-blue/15 border border-neon-blue/40 px-2 py-0.5 text-[11px] font-bold text-neon-blue uppercase">
                {msg.role} · #{msg.index}
              </span>
              <span className="text-[10.5px] text-mist-700 font-mono">
                {fmtNum(msg.stats.lines)} 行 · {fmtBytes(msg.stats.chars)}
              </span>
              {msg.reminderCount > 0 && (
                <span className="rounded-md bg-neon-amber/10 border border-neon-amber/30 px-2 py-0.5 text-[10.5px] text-neon-amber">
                  ⚠️ 含 {msg.reminderCount} 处系统注入 · 用户真实输入仅 {fmtNum(utteranceChars)} 字符
                </span>
              )}
            </div>
            {/* 内容块（按原始顺序） */}
            <div className="space-y-2.5">
              {msg.blocks.map((b, i) =>
                b.type === "system-reminder" ? (
                  <ReminderCallout key={i} block={b} n={++reminderNo} />
                ) : (
                  <UtteranceBubble key={i} block={b} />
                ),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
