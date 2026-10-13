import type { HeaderEntry } from "../types";

/**
 * <headers> 段：HTTP 请求头键值表。
 * [REDACTED] 脱敏项以 🔒 + 灰色斜体呈现；cosy-* 业务头打分组徽章。
 */
export function HeadersTable({ entries }: { entries: HeaderEntry[] }) {
  const redactedCount = entries.filter((e) => e.redacted).length;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-[11px] text-mist-500">
        <span className="rounded bg-ink-800 px-2 py-0.5 font-mono">{entries.length} 个头字段</span>
        {redactedCount > 0 && (
          <span className="rounded bg-neon-red/10 border border-neon-red/30 px-2 py-0.5 text-neon-red">
            🔒 {redactedCount} 项已脱敏
          </span>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-ink-700">
        <table className="w-full text-[12px] font-mono">
          <tbody>
            {entries.map((e, i) => (
              <tr
                key={`${e.key}-${i}`}
                className={`border-b border-ink-800 last:border-0 ${i % 2 ? "bg-ink-850/40" : "bg-transparent"} hover:bg-neon-cyan/[0.04]`}
              >
                <td className="px-3 py-1.5 whitespace-nowrap align-top w-1">
                  <span className="text-neon-cyan/90">{e.key}</span>
                  {e.key.startsWith("cosy-") && (
                    <span className="ml-2 rounded bg-neon-purple/10 px-1.5 py-px text-[9.5px] text-neon-purple align-middle">
                      cosy
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 align-top break-all">
                  {e.redacted ? (
                    <span className="italic text-mist-700 select-none" title="抓包时已脱敏">
                      🔒 [REDACTED]
                    </span>
                  ) : (
                    <span className="text-mist-300">{e.value}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
