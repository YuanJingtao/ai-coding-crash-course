import type { KV } from "../types";

/**
 * <params> / <model-config> 等 KV 段的网格展示。
 * 布尔值渲染为能力徽章，[REDACTED] 走脱敏样式，空值显示 —。
 */
export function KVGrid({ items }: { items: KV[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
      {items.map((kv, i) => {
        const isBool = kv.value === "true" || kv.value === "false";
        const redacted = kv.value === "[REDACTED]";
        return (
          <div
            key={`${kv.key}-${i}`}
            className="rounded-lg border border-ink-700 bg-ink-850/60 px-3 py-2"
          >
            <div className="text-[10.5px] text-mist-500 font-mono">{kv.key}</div>
            <div className="mt-0.5 font-mono text-[12.5px] break-all">
              {redacted ? (
                <span className="italic text-mist-700">🔒 [REDACTED]</span>
              ) : isBool ? (
                <span
                  className={
                    kv.value === "true"
                      ? "rounded bg-neon-green/10 border border-neon-green/30 px-1.5 py-px text-neon-green text-[11px]"
                      : "rounded bg-ink-700 px-1.5 py-px text-mist-500 text-[11px]"
                  }
                >
                  {kv.value}
                </span>
              ) : kv.value === "" ? (
                <span className="text-mist-700">—</span>
              ) : (
                <span className="text-mist-100">{kv.value}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
