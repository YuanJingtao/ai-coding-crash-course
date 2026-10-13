import { useState, type ReactNode } from "react";
import type { OtherFields } from "../types";
import { fmtBytes, fmtNum } from "../format";

/** 交互式 JSON 树：对象/数组可折叠，值按类型着色 */
function JsonNode({ k, value, depth = 0 }: { k?: string | number; value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  const keyLabel =
    k !== undefined ? (
      <span className="text-neon-purple">{typeof k === "number" ? `[${k}]` : `"${k}"`}</span>
    ) : null;

  if (value === null) return <Row>{keyLabel}<Null /></Row>;
  const t = typeof value;
  if (t === "string") return <Row>{keyLabel}<Str v={value as string} /></Row>;
  if (t === "number") return <Row>{keyLabel}<Num v={value as number} /></Row>;
  if (t === "boolean") return <Row>{keyLabel}<Bool v={value as boolean} /></Row>;

  const isArr = Array.isArray(value);
  const entries = isArr
    ? (value as unknown[]).map((v, i) => [i, v] as const)
    : Object.entries(value as Record<string, unknown>);
  const openBracket = isArr ? "[" : "{";
  const closeBracket = isArr ? "]" : "}";

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 hover:opacity-80 group">
        <span className={`text-mist-700 text-[10px] w-3 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        <span className="font-mono text-[12px]">
          {keyLabel}
          <span className="text-mist-500"> {openBracket}</span>
          {!open && (
            <span className="text-mist-700">
              {" "}…{entries.length} 项 {closeBracket}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="ml-4 border-l border-ink-700 pl-3">
          {entries.map(([ck, cv]) => (
            <JsonNode key={ck} k={ck} value={cv} depth={depth + 1} />
          ))}
          <div className="font-mono text-[12px] text-mist-500">{closeBracket}</div>
        </div>
      )}
    </div>
  );
}

const Row = ({ children }: { children: ReactNode }) => (
  <div className="flex font-mono text-[12px] leading-6 items-baseline">
    <span className="w-3 shrink-0" />
    <span className="min-w-0 break-all">{children}</span>
  </div>
);
const Str = ({ v }: { v: string }) => {
  const long = v.length > 120;
  const [expanded, setExpanded] = useState(false);
  const text = long && !expanded ? v.slice(0, 120) + "…" : v;
  return (
    <>
      <span className="text-neon-green/90">"{text}"</span>
      {long && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-2 text-[10px] text-neon-cyan hover:underline"
        >
          {expanded ? "收起" : `展开全部 (${fmtNum(v.length)} 字符)`}
        </button>
      )}
    </>
  );
};
const Num = ({ v }: { v: number }) => <span className="text-neon-amber">{String(v)}</span>;
const Bool = ({ v }: { v: boolean }) => <span className="text-neon-cyan">{String(v)}</span>;
const Null = () => <span className="text-mist-700 italic">null</span>;

/** <other-fields> 段 */
export function OtherFieldsSection({ data }: { data: OtherFields }) {
  return (
    <div className="space-y-3">
      {data.duplicateInjection && (
        <div className="rounded-lg border border-neon-amber/30 bg-neon-amber/[0.05] px-3.5 py-2.5 text-[12px] text-neon-amber flex items-start gap-2">
          <span>⚠️</span>
          <span>
            <b>chat_context.text</b> 字段（{fmtBytes(data.duplicateChars)}）与消息中的
            system-reminder 内容<span className="underline decoration-dotted">重复注入</span>
            —— 同一份上下文在请求体里出现了两次。
          </span>
        </div>
      )}
      {data.json !== null ? (
        <div className="rounded-lg border border-ink-700 bg-ink-950/60 p-3 max-h-[500px] overflow-auto">
          <JsonNode value={data.json} />
        </div>
      ) : (
        <pre className="rounded-lg border border-ink-700 bg-ink-950/60 p-3 text-[12px] font-mono text-mist-300 overflow-x-auto max-h-[500px]">
          {data.raw}
        </pre>
      )}
    </div>
  );
}
