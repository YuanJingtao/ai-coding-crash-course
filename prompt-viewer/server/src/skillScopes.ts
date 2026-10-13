/**
 * 技能作用域反推（best-effort，口径见 docs/context-panel-validation.md §8）。
 *
 * wire 注入列表没有作用域字段；/context 的 Project/User/Built-in 是 qodercli
 * 扫盘时按发现路径归类的。这里在解析期按同规则反推：
 * 1. Project —— <qodercli 发起目录> 下的项目级技能目录（`.qoder/skills`、`.agents/skills`、
 *    `.claude/skills`；发起目录配置在 skill-roots.json），优先级最高；
 * 2. User —— 用户级目录（~/.qoder / ~/.claude / ~/.agents / ~/.hermes / plugin marketplaces）；
 * 3. Built-in —— 残余（qodercli 内置，磁盘无对应目录）。
 *
 * 结果依赖解析机器；同名技能按 project > user 取先命中者（与 /context 一致：
 * 同时存在于项目与用户目录的技能只出现在 Project 组）。
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillLocation, SkillScope } from "./types.js";

const MAX_DEPTH = 5;

/**
 * 目录判定：跟随符号链接。
 * 项目 .qoder/skills 下大量条目是指向用户级目录（如 ~/.hermes/skills/*）的
 * 符号链接；Dirent.isDirectory() 对符号链接为 false，若不跟随会把这些技能
 * 漏判为用户级。环路由 MAX_DEPTH 兜底。
 */
function isDirFollowingSymlinks(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 递归收集「含 SKILL.md 的目录」：技能名（目录名）→ 目录绝对路径；同名先命中者赢 */
function collectSkillDirs(root: string, depth = 0, out = new Map<string, string>()): Map<string, string> {
  if (depth > MAX_DEPTH || !existsSync(root)) return out;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((e) => e.name === "SKILL.md" && isFileFollowingSymlinks(path.join(root, e.name)))) {
    const name = path.basename(root);
    if (!out.has(name)) out.set(name, root);
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const child = path.join(root, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && isDirFollowingSymlinks(child))) {
      collectSkillDirs(child, depth + 1, out);
    }
  }
  return out;
}

/** 列出技能目录下的文件（相对路径 + 字节数），供前端文件预览；跳过隐藏目录与 node_modules */
export function listSkillFiles(dir: string, maxFiles = 200): { rel: string; size: number }[] {
  const files: { rel: string; size: number }[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > 3 || files.length >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() || (e.isSymbolicLink() && isDirFollowingSymlinks(childAbs))) {
        walk(childAbs, childRel, depth + 1);
      } else if (e.isFile() || (e.isSymbolicLink() && isFileFollowingSymlinks(childAbs))) {
        try {
          files.push({ rel: childRel, size: statSync(childAbs).size });
        } catch {
          // 断链符号链接等：跳过
        }
      }
    }
  };
  walk(dir, "", 0);
  return files;
}

function isFileFollowingSymlinks(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** skill-roots.json：{ "projectRoots": ["<qodercli 发起目录>", ...] } */
function readProjectRoots(): string[] {
  const cfg = path.resolve(import.meta.dirname, "../skill-roots.json");
  try {
    const j = JSON.parse(readFileSync(cfg, "utf8")) as { projectRoots?: unknown };
    return Array.isArray(j.projectRoots)
      ? j.projectRoots.filter((r): r is string => typeof r === "string")
      : [];
  } catch {
    return [];
  }
}

function userScopeRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".qoder", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".hermes", "skills"),
    path.join(home, ".qoder", "plugins", "marketplaces"),
  ];
}

/** 项目级技能子目录（qodercli 在发起目录下都会扫）；按此顺序取先命中者 */
const PROJECT_SKILL_SUBDIRS = [".qoder/skills", ".agents/skills", ".claude/skills"];

/** name → { scope, dir }（project / user）；查不到的名字由调用方归为 builtin（无 dir） */
export function buildScopeIndex(): Map<string, SkillLocation> {
  const index = new Map<string, SkillLocation>();
  const merge = (dirs: Map<string, string>, scope: SkillScope): void => {
    for (const [name, dir] of dirs) {
      if (!index.has(name)) index.set(name, { scope, dir });
    }
  };
  for (const root of readProjectRoots()) {
    for (const sub of PROJECT_SKILL_SUBDIRS) {
      merge(collectSkillDirs(path.join(root, sub)), "project");
    }
  }
  for (const root of userScopeRoots()) {
    merge(collectSkillDirs(root), "user");
  }
  return index;
}

// ---- 磁盘兜底描述 ----

/**
 * 解析 SKILL.md 的 YAML frontmatter 里的 description。
 * 支持单行值与折叠块（`>-` / `|`）；无 frontmatter 或无 description 返回 null。
 * 只做够用的最小解析，不引 YAML 依赖。
 */
export function parseFrontmatterDescription(text: string): string | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") return null; // frontmatter 结束仍没遇到 description
    const m = /^description:\s*(.*)$/.exec(line);
    if (!m) continue;
    const head = m[1].trim();
    // 块指示符（>- / |）或「键行值为空、描述在后续缩进行」的 plain 多行标量，都走收集分支
    if (head === "" || head === ">" || head === ">-" || head === "|" || head === "|-") {
      const buf: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") {
          buf.push("");
          continue;
        }
        if (/^\s/.test(l)) {
          buf.push(l.trim());
          continue;
        }
        break;
      }
      return buf.join(" ").replace(/\s+/g, " ").trim() || null;
    }
    return head.replace(/^["']|["']$/g, "") || null;
  }
  return null;
}

const DESC_CACHE_TTL = 60_000;
const descCache = new Map<string, { at: number; desc: string | null }>();

/**
 * 读技能目录 SKILL.md 的描述（磁盘兜底）。60s TTL 缓存：一次解析可能上百个技能，
 * 不能每次请求都重读文件。读不到（无 SKILL.md / 无 frontmatter）返回 null 并缓存负结果。
 */
export function readSkillDescription(dir: string): string | null {
  const now = Date.now();
  const hit = descCache.get(dir);
  if (hit && now - hit.at < DESC_CACHE_TTL) return hit.desc;
  let desc: string | null = null;
  try {
    desc = parseFrontmatterDescription(readFileSync(path.join(dir, "SKILL.md"), "utf8"));
  } catch {
    desc = null;
  }
  descCache.set(dir, { at: now, desc });
  return desc;
}
