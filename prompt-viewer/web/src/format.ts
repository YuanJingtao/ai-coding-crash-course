export function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString("zh-CN");
}

export function fmtBytes(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / 1024 / 1024).toFixed(2)} MB`;
}

/** 行/字符统计的人类可读形式 */
export function fmtStats(lines: number, chars: number): string {
  return `${fmtNum(lines)} 行 · ${fmtBytes(chars)}`;
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** 粗略估算 token（混合中英文场景，~3.5 chars/token） */
export function estTokens(chars: number): string {
  return `≈${fmtNum(Math.round(chars / 3.5))} tok`;
}

/** 上下文窗口容量的人类可读形式（1,000,000 → "1M"；180,000 → "180K"） */
export function fmtWindow(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
