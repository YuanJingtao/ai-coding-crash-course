/**
 * Prompt Viewer 后端 —— Hono + TypeScript
 *
 * API:
 *   GET /api/logs               日志列表（时间倒序）
 *   GET /api/logs/:id           解析后的 Parsed Log JSON（解析失败降级返回 raw）
 *   GET /api/skills/:name[/file] 技能文件预览（白名单限定扫盘索引目录）
 *   GET /api/skill-categories   读取技能分类档（name→categoryId 全局映射）
 *   PUT /api/skill-categories   整档覆盖写回（原子写；这是后端唯一的写路径）
 *
 * 日志目录只读；唯一可写的是 server/skill-categories.json（gitignore 的个人分类档）。
 * 生产模式下同时静态托管 ../web/dist。
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { classifyWireLog, parseWireLog } from "./parser.js";
import { buildScopeIndex, listSkillFiles, readSkillDescription } from "./skillScopes.js";
import { readSkillSources } from "./skillSources.js";
import {
  buildCategoryIndex,
  CATEGORY_COLORS,
  normalizeDoc,
  readCategoriesDoc,
  writeCategoriesDoc,
} from "./skillCategories.js";
import type { LogListItem, SkillCategoriesDoc, SkillLocation, SkillSource } from "./types.js";

const LOGS_DIR = path.resolve(import.meta.dirname, "../../../request-logger/logs");

/** 技能作用域索引（扫盘反推）：30s TTL 缓存，避免每次请求重扫目录树 */
let scopeCache: { at: number; index: Map<string, SkillLocation> } | null = null;
function scopeIndex(): Map<string, SkillLocation> {
  const now = Date.now();
  if (!scopeCache || now - scopeCache.at > 30_000) {
    scopeCache = { at: now, index: buildScopeIndex() };
  }
  return scopeCache.index;
}

/** 技能分类档：30s TTL 缓存；PUT 写盘后置 null 立即失效，避免读到旧档 */
let categoryCache: { at: number; doc: SkillCategoriesDoc } | null = null;
function categoriesDoc(): SkillCategoriesDoc {
  const now = Date.now();
  if (!categoryCache || now - categoryCache.at > 30_000) {
    categoryCache = { at: now, doc: readCategoriesDoc() };
  }
  return categoryCache.doc;
}
const PORT = Number(process.env.PORT ?? 3001);

/** 技能来源档：30s TTL 缓存（只读文件，无写路径） */
let sourceCache: { at: number; index: Map<string, SkillSource> } | null = null;
function sourceIndex(): Map<string, SkillSource> {
  const now = Date.now();
  if (!sourceCache || now - sourceCache.at > 30_000) {
    sourceCache = { at: now, index: readSkillSources() };
  }
  return sourceCache.index;
}

const app = new Hono();
app.use("/api/*", cors());

app.get("/api/health", (c) => c.json({ ok: true, logsDir: LOGS_DIR }));

app.get("/api/logs", async (c) => {
  if (!existsSync(LOGS_DIR)) {
    return c.json({ ok: false, error: `日志目录不存在: ${LOGS_DIR}` }, 500);
  }
  const files = (await readdir(LOGS_DIR)).filter((f) => f.endsWith(".md"));
  const items: LogListItem[] = [];
  for (const fileName of files) {
    const st = await stat(path.join(LOGS_DIR, fileName));
    const id = fileName.replace(/\.md$/, "");
    // 文件名形如 2026-09-10T12-55-47-451_qoder.md
    const tm = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})_(.+)$/);
    // 分类需要读文件内容（主判据 other-fields.task_id 在文件深处，只能整读；
    // 当前 logs 规模为毫秒级，文件多了再优化为 head+tail 读取）。
    // 读取失败按 fail-open 处理：归为主对话，宁可多显示也不误藏。
    let kind: LogListItem["kind"] = "main";
    let auxTask: string | null = null;
    try {
      const cls = classifyWireLog(await readFile(path.join(LOGS_DIR, fileName), "utf-8"));
      kind = cls.kind;
      auxTask = cls.auxTask;
    } catch {
      // 保持 fail-open 默认值
    }
    items.push({
      id,
      fileName,
      size: st.size,
      mtime: st.mtime.toISOString(),
      timestamp: tm ? `${tm[1]}T${tm[2]}:${tm[3]}:${tm[4]}.${tm[5]}Z` : null,
      agent: tm ? tm[6] : null,
      kind,
      auxTask,
    });
  }
  items.sort((a, b) => b.fileName.localeCompare(a.fileName));
  return c.json({ ok: true, items });
});

app.get("/api/logs/:id", async (c) => {
  const id = c.req.param("id");
  // 路径穿越防护：只允许日志文件名的字符集
  if (!/^[\w.-]+$/.test(id) || id.includes("..")) {
    return c.json({ ok: false, parseError: "非法的日志 id" }, 400);
  }
  const file = path.join(LOGS_DIR, `${id}.md`);
  if (!existsSync(file)) {
    return c.json({ ok: false, parseError: `日志不存在: ${id}` }, 404);
  }
  const text = await readFile(file, "utf-8");
  try {
    const log = parseWireLog(
      id,
      path.basename(file),
      text,
      scopeIndex(),
      buildCategoryIndex(categoriesDoc()),
      sourceIndex(),
      readSkillDescription,
    );
    return c.json({ ok: true, log });
  } catch (err) {
    // 解析失败降级：返回 raw 文本，前端以纯文本展示
    return c.json({
      ok: false,
      parseError: err instanceof Error ? err.message : String(err),
      raw: text,
    });
  }
});

// 技能文件预览：白名单限定为扫盘反推索引中的目录（name 必须命中索引），不接受任意路径
app.get("/api/skills/:name", (c) => {
  const loc = scopeIndex().get(c.req.param("name"));
  if (!loc) {
    return c.json({ ok: false, error: "技能不在扫盘索引中（builtin 或扫盘不可用）" }, 404);
  }
  return c.json({ ok: true, dir: loc.dir, scope: loc.scope, files: listSkillFiles(loc.dir) });
});

const MAX_PREVIEW_BYTES = 1_000_000;
app.get("/api/skills/:name/file", async (c) => {
  const loc = scopeIndex().get(c.req.param("name"));
  if (!loc) {
    return c.json({ ok: false, error: "技能不在扫盘索引中（builtin 或扫盘不可用）" }, 404);
  }
  const rel = c.req.query("rel") ?? "SKILL.md";
  const abs = path.resolve(loc.dir, rel);
  if (abs !== loc.dir && !abs.startsWith(loc.dir + path.sep)) {
    return c.json({ ok: false, error: "非法路径" }, 400);
  }
  const st = await stat(abs).catch(() => null);
  if (!st?.isFile()) return c.json({ ok: false, error: `文件不存在: ${rel}` }, 404);
  if (st.size > MAX_PREVIEW_BYTES) {
    return c.json({ ok: false, error: `文件过大（${st.size} 字节，预览上限 1MB）` }, 413);
  }
  const content = await readFile(abs, "utf-8");
  return c.json({ ok: true, rel, bytes: st.size, content });
});

// ---- 技能分类档（唯一写路径）----

/** 读整档：categories + assignments（app 级、与具体日志无关） */
app.get("/api/skill-categories", (c) => {
  const doc = categoriesDoc();
  return c.json({ ok: true, categories: doc.categories, assignments: doc.assignments });
});

/**
 * PUT 边界校验：结构不对直接 400。normalizeDoc 只做兜底收敛（丢坏字段、去重、
 * 清孤儿 assignment），不代替这里的形状校验——畸形请求应当被明确拒绝而非静默吞掉。
 */
function validateCategoriesDoc(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "顶层必须是对象";
  const { categories, assignments } = raw as { categories?: unknown; assignments?: unknown };
  if (!Array.isArray(categories)) return "categories 必须是数组";
  const colors = CATEGORY_COLORS as readonly string[];
  for (const item of categories) {
    if (!item || typeof item !== "object") return "每个 category 必须是对象";
    const e = item as { id?: unknown; label?: unknown; color?: unknown; order?: unknown; parentId?: unknown };
    if (typeof e.id !== "string" || e.id === "") return "category.id 必须是非空字符串";
    if (e.label !== undefined && typeof e.label !== "string") return "category.label 必须是字符串";
    if (e.color !== undefined && (typeof e.color !== "string" || !colors.includes(e.color))) {
      return `category.color 非法: ${String(e.color)}`;
    }
    if (e.order !== undefined && typeof e.order !== "number") return "category.order 必须是数字";
    if (e.parentId !== undefined && e.parentId !== null && typeof e.parentId !== "string") {
      return "category.parentId 必须是字符串或 null";
    }
  }
  if (assignments !== undefined) {
    if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) {
      return "assignments 必须是对象";
    }
    for (const [name, catId] of Object.entries(assignments as Record<string, unknown>)) {
      if (typeof catId !== "string") return `assignments["${name}"] 必须是字符串（categoryId）`;
    }
  }
  return null;
}

/** 整档覆盖写回：校验 → 归一化 → 原子写 → 失效缓存 */
app.put("/api/skill-categories", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }
  const invalid = validateCategoriesDoc(raw);
  if (invalid) return c.json({ ok: false, error: invalid }, 400);
  const doc = normalizeDoc(raw);
  try {
    await writeCategoriesDoc(doc);
  } catch (err) {
    return c.json({ ok: false, error: `写入失败: ${(err as Error).message}` }, 500);
  }
  categoryCache = null; // 立即失效：下一次解析就读到新档，无需等 TTL
  return c.json({ ok: true, categories: doc.categories, assignments: doc.assignments });
});

// 生产模式：静态托管前端构建产物（存在时）
const distDir = path.resolve(import.meta.dirname, "../../web/dist");
if (existsSync(distDir)) {
  app.use("/*", serveStatic({ root: "../web/dist" }));
  app.get("*", serveStatic({ path: "../web/dist/index.html" }));
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[prompt-viewer] server listening on http://localhost:${info.port}`);
  console.log(`[prompt-viewer] logs dir: ${LOGS_DIR}`);
});
