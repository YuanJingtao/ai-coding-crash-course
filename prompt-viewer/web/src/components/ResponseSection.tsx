import { useState } from "react";
import type { ParsedLog, Section } from "../types";
import { fmtNum } from "../format";
import { Badge } from "./SectionCard";
import { Markdown } from "./Markdown";

/** <thinking>：紫色思考块，默认折叠、斜体 */
function ThinkingBlock({ section }: { section: Section<string> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-neon-purple/30 bg-neon-purple/[0.04] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-neon-purple/[0.06] transition-colors"
        aria-expanded={open}
      >
        <span className="rounded-md bg-neon-purple/15 border border-neon-purple/40 px-2 py-0.5 text-[10.5px] font-bold text-neon-purple">
          💭 模型思考过程
        </span>
        <span className="text-[10.5px] text-mist-700 font-mono">
          {fmtNum(section.stats.lines)} 行 · reasoning
        </span>
        <span className={`ml-auto text-neon-purple/60 text-[10px] transition-transform ${open ? "rotate-90" : ""}`}>
          ▶
        </span>
      </button>
      {open && (
        <div className="border-t border-neon-purple/20 px-4 py-3 bg-ink-950/40">
          <div className="italic opacity-90">
            <Markdown>{section.data}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}

export function ResponseSection({ log }: { log: ParsedLog }) {
  const r = log.response;
  if (!r) {
    return <div className="text-sm text-mist-500">本日志没有 response 段。</div>;
  }
  const u = r.usage;
  return (
    <div className="space-y-4">
      {/* finish reason + usage */}
      <div className="flex flex-wrap items-center gap-2">
        {r.finishReason && (
          <Badge accent={r.finishReason === "stop" ? "green" : "amber"}>
            finish_reason: {r.finishReason}
            {r.finishReason === "stop" && " · 正常结束"}
          </Badge>
        )}
        {u?.billable !== undefined && (
          <Badge accent={u.billable ? "amber" : "blue"}>
            {u.billable ? "计费请求" : "不计费"}
          </Badge>
        )}
      </div>

      {u && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {[
            { label: "Prompt Tokens", v: u.prompt_tokens, color: "text-neon-blue" },
            { label: "其中缓存命中", v: u.cached_tokens, color: "text-neon-cyan" },
            { label: "Completion Tokens", v: u.completion_tokens, color: "text-neon-green" },
            { label: "其中 Reasoning", v: u.reasoning_tokens, color: "text-neon-purple" },
            { label: "Total Tokens", v: u.total_tokens, color: "text-mist-100" },
          ].map((c) => (
            <div key={c.label} className="rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2">
              <div className="text-[10.5px] text-mist-500">{c.label}</div>
              <div className={`font-mono text-base font-bold ${c.color}`}>
                {c.v !== undefined ? fmtNum(c.v) : "—"}
              </div>
            </div>
          ))}
        </div>
      )}

      {u?.credits !== undefined && (
        <div className="text-[12px] font-mono text-neon-amber">
          💰 本次调用消耗 {u.credits.toFixed(6)} credits
        </div>
      )}

      {r.thinking && <ThinkingBlock section={r.thinking} />}

      {r.assistantText && (
        <div className="rounded-xl border border-neon-green/30 bg-neon-green/[0.03] p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-md bg-neon-green/15 border border-neon-green/40 px-2 py-0.5 text-[10.5px] font-bold text-neon-green">
              🤖 助手回复
            </span>
            <span className="text-[10.5px] text-mist-700 font-mono">
              {fmtNum(r.assistantText.stats.lines)} 行
            </span>
          </div>
          <Markdown>{r.assistantText.data}</Markdown>
        </div>
      )}
    </div>
  );
}
