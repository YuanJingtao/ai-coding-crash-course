import type { LogDetailResponse, LogListItem, SkillCategoriesDoc } from "./types";

/** 默认展示这份 177KB 的完整日志 */
export const DEFAULT_LOG_ID = "2026-09-10T12-55-47-451_qoder";

export async function fetchLogs(): Promise<LogListItem[]> {
  const res = await fetch("/api/logs");
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? "获取日志列表失败");
  return data.items as LogListItem[];
}

export async function fetchLog(id: string): Promise<LogDetailResponse> {
  const res = await fetch(`/api/logs/${encodeURIComponent(id)}`);
  return (await res.json()) as LogDetailResponse;
}

/** 读取技能分类档（app 级、与具体日志无关；文件缺失时后端返回空档） */
export async function fetchSkillCategories(): Promise<SkillCategoriesDoc> {
  const res = await fetch("/api/skill-categories");
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? "获取技能分类失败");
  return { categories: data.categories ?? [], assignments: data.assignments ?? {} };
}

/** 整档覆盖写回；返回服务端归一化后的档（id 去重、孤儿 assignment 已清） */
export async function saveSkillCategories(doc: SkillCategoriesDoc): Promise<SkillCategoriesDoc> {
  const res = await fetch("/api/skill-categories", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? "保存技能分类失败");
  return { categories: data.categories ?? [], assignments: data.assignments ?? {} };
}
