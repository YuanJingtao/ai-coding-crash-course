/**
 * 技能文件页的 hash 路由：`#/skill/<name>?rel=<file>`。
 * 用 hash 而非 history 路由：生产模式由 Hono 兜底返回 index.html，hash 不进服务端，
 * 无需任何 rewrite 配置即可直接打开/刷新深链。
 */

/** 技能名可含冒号（`plugin:skill`），整体 encode；rel 含斜杠，同样 encode */
export function skillFileHref(name: string, rel?: string | null): string {
  const query = rel ? `?rel=${encodeURIComponent(rel)}` : "";
  return `#/skill/${encodeURIComponent(name)}${query}`;
}

export interface SkillRoute {
  name: string;
  rel: string | null;
}

/** 解析 hash；不是技能文件页路由时返回 null（回落到日志查看器） */
export function parseSkillRoute(hash: string): SkillRoute | null {
  const [pathPart, queryPart = ""] = hash.replace(/^#/, "").split("?");
  const m = /^\/skill\/(.+)$/.exec(pathPart);
  if (!m) return null;
  let name: string;
  try {
    name = decodeURIComponent(m[1]);
  } catch {
    return null; // 畸形转义（手改 URL）：当无路由处理
  }
  return { name, rel: new URLSearchParams(queryPart).get("rel") };
}
