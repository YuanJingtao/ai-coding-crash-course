import type { ParsedLog } from "../types";
import { fmtBytes, fmtNum, fmtTime, fmtWindow } from "../format";
import { Badge } from "./SectionCard";

function metaGet(log: ParsedLog, key: string): string {
  return log.meta.find((m) => m.key === key)?.value ?? "";
}

function StatCard({
  label,
  value,
  sub,
  accent = "text-mist-100",
  glow,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  glow?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border border-ink-700 bg-ink-850/80 px-3.5 py-3 ${glow ? "glow-green" : ""}`}
    >
      <div className="text-[11px] text-mist-500 mb-1">{label}</div>
      <div className={`font-mono text-lg font-bold leading-tight ${accent}`}>{value}</div>
      {sub && <div className="text-[10.5px] text-mist-700 mt-0.5 font-mono">{sub}</div>}
    </div>
  );
}

/** 缓存命中率环形图 */
function CacheRing({ rate }: { rate: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="#1d2433" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="#56c8d8"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(rate / 100) * c} ${c}`}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-bold text-neon-cyan">
        {rate}%
      </div>
    </div>
  );
}

/** prompt token 构成条 */
function TokenBar({ log }: { log: ParsedLog }) {
  const u = log.response?.usage;
  if (!u?.prompt_tokens) return null;
  const cached = u.cached_tokens ?? 0;
  const fresh = Math.max(0, u.prompt_tokens - cached);
  const completion = u.completion_tokens ?? 0;
  const total = u.prompt_tokens + completion;
  const seg = (n: number) => `${(n / total) * 100}%`;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full border border-ink-700">
        <div className="bg-neon-cyan/80" style={{ width: seg(cached) }} title={`缓存命中 ${fmtNum(cached)}`} />
        <div className="bg-neon-blue/80" style={{ width: seg(fresh) }} title={`新计算 prompt ${fmtNum(fresh)}`} />
        <div className="bg-neon-green/80" style={{ width: seg(completion) }} title={`completion ${fmtNum(completion)}`} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-mist-500 font-mono">
        <span><i className="inline-block h-2 w-2 rounded-sm bg-neon-cyan/80 mr-1.5" />缓存命中 {fmtNum(cached)}</span>
        <span><i className="inline-block h-2 w-2 rounded-sm bg-neon-blue/80 mr-1.5" />新 prompt {fmtNum(fresh)}</span>
        <span><i className="inline-block h-2 w-2 rounded-sm bg-neon-green/80 mr-1.5" />completion {fmtNum(completion)}</span>
        {u.reasoning_tokens ? <span className="text-neon-purple">其中 reasoning {fmtNum(u.reasoning_tokens)}</span> : null}
      </div>
    </div>
  );
}

export function Overview({ log }: { log: ParsedLog }) {
  const d = log.derived;
  const u = log.response?.usage;
  const ctx = log.context;
  const agent = metaGet(log, "agent") || "—";
  const modelKv = log.request.modelConfig.find((m) => m.key === "display_name")?.value;
  const model = modelKv || metaGet(log, "model") || "—";
  const status = metaGet(log, "upstream status");
  const ts = metaGet(log, "timestamp");

  return (
    <div id="overview" className="scroll-mt-4 space-y-4">
      {/* Hero */}
      <div className="relative rounded-xl border border-ink-700 bg-gradient-to-br from-ink-850 via-ink-900 to-ink-950 p-5 overflow-hidden glow-cyan">
        <div
          className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full opacity-20 blur-3xl"
          style={{ background: "radial-gradient(circle, #56c8d8 0%, transparent 70%)" }}
        />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-mist-100">
              一次「你好」的完整旅程
            </h1>
            <p className="mt-1 text-[12.5px] text-mist-500">
              用户只说了{" "}
              <span className="text-neon-green font-semibold">
                {fmtNum(d.utteranceChars)} 个字符
              </span>
              ，Agent 向大模型实际发送了{" "}
              <span className="text-neon-cyan font-semibold">{fmtBytes(d.totalChars)}</span> 的
              wire 请求 —— 下面是它的全部构成。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge accent="purple">🤖 {agent}</Badge>
            <Badge accent="cyan">🧠 {model}</Badge>
            <Badge accent="blue">🕐 {fmtTime(ts)}</Badge>
            {status && <Badge accent={status === "200" ? "green" : "red"}>HTTP {status}</Badge>}
          </div>
        </div>
        <div className="mt-2 font-mono text-[11px] text-mist-700 truncate">{log.fileName}</div>
      </div>

      {/* 统计卡 */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-8 gap-3">
        <StatCard
          label="用户真实输入"
          value={`${fmtNum(d.utteranceChars)} 字符`}
          sub="剔除全部系统注入后"
          accent="text-neon-green"
          glow
        />
        <StatCard
          label="系统注入"
          value={`${d.reminderCount} 处`}
          sub={`${fmtBytes(d.reminderChars)} · system-reminder`}
          accent="text-neon-amber"
        />
        <StatCard
          label="注入放大比"
          value={d.injectionRatio !== null ? `${fmtNum(d.injectionRatio)}×` : "—"}
          sub="注入字符 ÷ 用户输入字符"
          accent="text-neon-red"
        />
        <StatCard
          label="Prompt Tokens"
          value={u?.prompt_tokens ? fmtNum(u.prompt_tokens) : "—"}
          sub={u?.total_tokens ? `总计 ${fmtNum(u.total_tokens)}` : undefined}
          accent="text-neon-blue"
        />
        <StatCard label="工具定义" value={`${d.toolCount} 个`} sub="tools 段" accent="text-neon-cyan" />
        <StatCard
          label="技能注入"
          value={`${d.skillCount} 个`}
          sub={d.skillPlaceholderCount > 0 ? `其中 ${d.skillPlaceholderCount} 个占位` : "system-reminder 技能列表"}
          accent="text-neon-purple"
        />
        <StatCard
          label="体积"
          value={fmtBytes(d.totalChars)}
          sub={`${fmtNum(d.totalLines)} 行`}
          accent="text-mist-100"
        />
        <StatCard
          label="上下文占用"
          value={ctx.usedPercent !== null ? `${ctx.usedPercent}%` : `${fmtNum(ctx.usedTokens)} tok`}
          sub={`${fmtWindow(ctx.contextLength)} 窗口 · ${ctx.anchor === "usage" ? "服务端真值" : "本地估算"}`}
          accent="text-neon-cyan"
        />
      </div>

      {/* token 构成 + 缓存环 + credits */}
      {u && (
        <div className="rounded-xl border border-ink-700 bg-ink-900/70 p-4 flex flex-col sm:flex-row items-center gap-5">
          <div className="flex items-center gap-4">
            {d.cacheHitRate !== null && <CacheRing rate={d.cacheHitRate} />}
            <div>
              <div className="text-[11px] text-mist-500">Prompt 缓存命中率</div>
              <div className="font-mono text-sm text-mist-100">
                {fmtNum(u.cached_tokens ?? 0)} / {fmtNum(u.prompt_tokens ?? 0)}
              </div>
              {u.credits !== undefined && (
                <div className="mt-1 text-[11px] font-mono text-neon-amber">
                  💰 {u.credits.toFixed(4)} credits
                  {u.billable === false && <span className="text-mist-700"> (不计费)</span>}
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 w-full">
            <TokenBar log={log} />
          </div>
        </div>
      )}
    </div>
  );
}
