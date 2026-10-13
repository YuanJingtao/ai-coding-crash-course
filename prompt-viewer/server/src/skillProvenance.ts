/**
 * 技能出处凭据解析（扫盘 best-effort，口径见 CONTEXT.md「出处凭据」）。
 *
 * `source`（渠道）说的是「我从哪条路拿到的」，本模块解析的是另一维：「上游是谁写的、
 * 在哪个 repo」。两者正交——`mcp-builder` 可以既是从 Aone 市场下的（source=aone），
 * 又是 Anthropic 写的（vendor=anthropic）。
 *
 * 凭据分两档，UI 需据此区分可信度：
 * 1. `install-record` —— 本机安装凭据（skills CLI 的 lock 文件、插件注册表
 *    `installed_plugins_v2.json` + 插件 manifest 的 `repository` 字段），确凿；
 * 2. `catalog-match` —— 上游技能目录里的同名条目，只能证明「有个同名技能在那个 repo」，
 *    不证明是从那装的，同名不同源会误判。
 *
 * 插件技能以 `pluginName:skillName` 命名空间索引：skills CLI 的 lock 只记裸名，
 * 匹配不到命名空间名，插件注册表是它们的唯一凭据来源。
 *
 * 结果依赖解析机器：换一台机器注册表不同，出处列会变。与 skillScopes 同类局限。
 * 任何注册表缺失/损坏一律跳过，绝不抛错。
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillProvenance, SkillVendor } from "./types.js";
import { collectSkillDirs, readProjectRoots } from "./skillScopes.js";

/**
 * 第一方 org（repo owner）→ 厂商标识。不在此表的 owner 一律归 community（公版）：
 * 个人/社区作者发布的公开技能包，如 JimLiu(baoyu)、mattpocock、mhattingpete。
 */
const FIRST_PARTY_ORGS: Record<string, SkillVendor> = {
  anthropics: "anthropic",
  "anthropic-experimental": "anthropic",
  "vercel-labs": "vercel",
  vercel: "vercel",
  alibaba: "alibaba",
  aliyun: "alibaba",
  dingtalk: "alibaba",
  qoder: "qoder",
};

/** skills CLI 的 lock 文件名（相对某个根目录）；两种版本 schema 都由 readLock 兼容 */
const LOCK_RELPATHS = [
  ".agents/.skill-lock.json",
  ".agents/skills/skills-lock.json",
  "skills-lock.json",
  ".claude/skills-lock.json",
];

/** 向上找 lock 文件的最大层数（viewer 在 <repo>/prompt-viewer/server/src，需 3 层到 repo 根） */
const ANCESTOR_DEPTH = 4;

function readJson(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * 归一化成 `owner/repo`。接受 `owner/repo`、`https://github.com/owner/repo[.git]`、
 * `git@github.com:owner/repo.git`；非 GitHub 形态返回 null（内部 git 源不硬编公网地址）。
 */
function normalizeRepo(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  const ssh = /^git@github\.com:(.+)$/.exec(s);
  if (ssh) s = ssh[1];
  else s = s.replace(/^https?:\/\/github\.com\//, "");
  s = s.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const parts = s.split("/");
  return parts.length === 2 && parts.every(Boolean) ? s : null;
}

/** repo + 目录内路径 → 可点击地址。用 HEAD 而非 main，规避默认分支名差异 */
function githubUrl(repo: string, subPath: string | null): string {
  // 指向技能目录而非 SKILL.md 文件：目录页在 GitHub 上可读性更好，且不随入口文件名变化
  const dir = (subPath ?? "").replace(/\.git$/, "").replace(/\/SKILL\.md$/, "").replace(/^\/+|\/+$/g, "");
  return dir ? `https://github.com/${repo}/tree/HEAD/${dir}` : `https://github.com/${repo}`;
}

function vendorOf(repo: string | null): SkillVendor | null {
  if (!repo) return null;
  return FIRST_PARTY_ORGS[repo.split("/")[0].toLowerCase()] ?? "community";
}

/** 收集要扫 lock 文件的根目录：项目根（skill-roots.json）+ viewer 自身祖先链 */
function lockRoots(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (!seen.has(real)) {
      seen.add(real);
      roots.push(real);
    }
  };
  for (const r of readProjectRoots()) add(r);
  let cur = path.resolve(import.meta.dirname, "..");
  for (let i = 0; i < ANCESTOR_DEPTH; i++) {
    add(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return roots;
}

interface LockHit {
  repo: string | null;
  subPath: string | null;
  installedAt: string | null;
  registry: string;
}

/**
 * 扫所有 skills CLI lock 文件。两种 schema 兼容：
 * v3（~/.agents/.skill-lock.json）有 sourceUrl/installedAt；v1 只有 source/computedHash。
 * 同名技能取先命中者，但带 sourceUrl 的记录优先（信息更全）。
 */
function readLocks(): Map<string, LockHit> {
  const out = new Map<string, LockHit>();
  const files: string[] = [];
  for (const root of lockRoots()) {
    for (const rel of LOCK_RELPATHS) {
      const p = path.join(root, rel);
      if (existsSync(p)) files.push(p);
    }
  }
  // 用户级 ~/.agents 固定扫；lockRoots 的祖先链只覆盖 viewer 所在仓库
  for (const rel of LOCK_RELPATHS) {
    const p = path.join(os.homedir(), rel);
    if (existsSync(p)) files.push(p);
  }

  for (const file of files) {
    const doc = readJson(file);
    if (!isRecord(doc) || !isRecord(doc.skills)) continue;
    for (const [name, v] of Object.entries(doc.skills)) {
      if (!isRecord(v)) continue;
      const repo = normalizeRepo(str(v.sourceUrl) ?? str(v.source));
      const hit: LockHit = {
        repo,
        subPath: str(v.skillPath),
        installedAt: str(v.installedAt),
        registry: path.basename(file),
      };
      const prev = out.get(name);
      // 已有记录且带 repo，新记录没有 → 不覆盖（避免弱信息冲掉强信息）
      if (prev && prev.repo && !repo) continue;
      out.set(name, hit);
    }
  }
  return out;
}

interface CatalogHit {
  repo: string;
  subPath: string | null;
  /** identifier 与 repo+path 自洽 = 该表的 path 基准可信 */
  consistent: boolean;
}

/**
 * 扫 hermes hub 的上游目录缓存（index-cache/*.json）。这些是**上游 catalog**而非本机安装记录，
 * 故只作 catalog-match 级证据。
 *
 * 多份 catalog 的 path 基准不一致：`anthropics_skills_skills_.json` 的 path 相对 repo 根
 * （`skills/docx`），而 `skills_sh_featured.json` 剥掉了首层（`docx`）。用
 * `identifier === repo + "/" + path` 自洽性挑可信的那份。
 */
function readCatalogs(): Map<string, CatalogHit> {
  const out = new Map<string, CatalogHit>();
  const dir = path.join(os.homedir(), ".hermes", "skills", ".hub", "index-cache");
  if (!existsSync(dir)) return out;

  const consider = (name: string, hit: CatalogHit) => {
    const prev = out.get(name);
    if (!prev || (!prev.consistent && hit.consistent)) out.set(name, hit);
  };

  for (const file of safeReaddir(dir)) {
    if (!file.endsWith(".json")) continue;
    const doc = readJson(path.join(dir, file));
    const items = Array.isArray(doc)
      ? doc
      : isRecord(doc) && Array.isArray(doc.skills)
        ? doc.skills
        : [];
    for (const x of items) {
      if (!isRecord(x)) continue;
      const name = str(x.name);
      const repo = normalizeRepo(str(x.repo));
      if (!name || !repo) continue; // repo 为空的是 hermes 自有 builtin 条目，无公网出处
      const subPath = str(x.path);
      const identifier = str(x.identifier);
      consider(name, {
        repo,
        subPath,
        consistent: identifier === `${repo}/${subPath ?? ""}`,
      });
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

interface HubHit {
  identifier: string | null;
  installPath: string | null;
  source: string | null;
}

/** hermes hub 的本机安装记录（lock.json）：有 identifier/install_path，但通常无公网 repo */
function readHubLock(): Map<string, HubHit> {
  const out = new Map<string, HubHit>();
  const doc = readJson(path.join(os.homedir(), ".hermes", "skills", ".hub", "lock.json"));
  if (!isRecord(doc) || !isRecord(doc.installed)) return out;
  for (const [name, v] of Object.entries(doc.installed)) {
    if (!isRecord(v)) continue;
    out.set(name, {
      identifier: str(v.identifier),
      installPath: str(v.install_path),
      source: str(v.source),
    });
  }
  return out;
}

interface PluginHit {
  repo: string | null;
  subPath: string | null;
  installedAt: string | null;
}

/** 插件 manifest 的 repository 字段；字符串或 npm 风格 `{ url }` 对象都收 */
function manifestRepo(installPath: string): string | null {
  for (const rel of [".qoder-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    const m = readJson(path.join(installPath, rel));
    if (!isRecord(m)) continue;
    const r = m.repository;
    const raw = typeof r === "string" ? r : isRecord(r) ? str(r.url) : null;
    const repo = normalizeRepo(raw);
    if (repo) return repo;
  }
  return null;
}

/**
 * 插件注册表（installed_plugins_v2.json）：wire 里 `pluginName:skillName` 命名空间技能的
 * 凭据来源。skills CLI 的 lock 只记**裸名**，匹配不到命名空间名，故插件技能此前零覆盖——
 * `mattpocock-skills:code-review` 的上游其实写在插件 manifest 的 `repository` 字段里
 * （github.com/mattpocock/skills），marketplace 目录本身也是该 repo 的 git clone。
 * 以 `pluginName:skillName` 索引，与 wire 注入名一致。
 */
function readPlugins(): Map<string, PluginHit> {
  const out = new Map<string, PluginHit>();
  const doc = readJson(path.join(os.homedir(), ".qoder", "plugins", "installed_plugins_v2.json"));
  if (!isRecord(doc) || !isRecord(doc.plugins)) return out;
  for (const [key, versions] of Object.entries(doc.plugins)) {
    const pluginName = key.split("@")[0];
    if (!Array.isArray(versions)) continue;
    for (const v of versions) {
      if (!isRecord(v)) continue;
      const installPath = str(v.installPath);
      if (!installPath) continue;
      const repo = manifestRepo(installPath);
      const installedAt = str(v.installedAt);
      for (const [skillName, dir] of collectSkillDirs(installPath)) {
        const ns = `${pluginName}:${skillName}`;
        if (out.has(ns)) continue;
        out.set(ns, { repo, subPath: path.relative(installPath, dir) || null, installedAt });
      }
    }
  }
  return out;
}

/**
 * 组装 name → 出处。
 *
 * `localNames` 是**本机确实存在的技能名**（取自 scopeIndex 的键），用来给 catalog 匹配设闸：
 * index-cache 里的表是「上游可安装目录」（hermes-index 842 条 + skills.sh featured 100 条），
 * 绝大多数本机并未安装。不加闸会把这近千条全灌进索引，且任何同名本地技能都会被错误归属
 * （例如上游 garrytan/gstack 有个 `benchmark`，与本机任何同名技能毫无关系）。
 * 安装凭据（lock / hub）不受此限——它们本身就是本机记录。
 *
 * `vendorOverrides` 来自 skill-sources.json 的 `vendors` 段，用于内部包等注册表覆盖不到的场景
 * （如 `dws`：Apache-2.0 + NOTICE 证明是钉钉官方，但没有公网 repo）。override 优先级最高。
 *
 * 查不到任何凭据、也没有 override 的技能不出现在结果里（前端 provenance 为 null）。
 */
export function buildProvenanceIndex(
  localNames: ReadonlySet<string>,
  vendorOverrides: Map<string, SkillVendor> = new Map(),
): Map<string, SkillProvenance> {
  const locks = readLocks();
  const catalogs = readCatalogs();
  const hub = readHubLock();
  const plugins = readPlugins();
  const out = new Map<string, SkillProvenance>();

  const names = new Set<string>([
    ...locks.keys(),
    ...hub.keys(),
    ...plugins.keys(),
    ...vendorOverrides.keys(),
  ]);
  for (const name of catalogs.keys()) {
    if (localNames.has(name)) names.add(name);
  }

  for (const name of names) {
    const lock = locks.get(name);
    const cat = catalogs.get(name);
    const hubHit = hub.get(name);
    const plug = plugins.get(name);
    const override = vendorOverrides.get(name) ?? null;

    // 证据优先级：本机安装凭据（skills CLI lock / 插件注册表）> 上游目录同名 > hub 安装记录
    const repo = lock?.repo ?? plug?.repo ?? cat?.repo ?? null;
    const subPath = lock?.subPath ?? plug?.subPath ?? cat?.subPath ?? null;
    const evidence: SkillProvenance["evidence"] | null =
      lock?.repo || plug?.repo
        ? "install-record"
        : cat?.repo
          ? "catalog-match"
          : hubHit
            ? "install-record"
            : null;

    const vendor = override ?? vendorOf(repo) ?? (hubHit ? "community" : null);
    if (!repo && !vendor && !hubHit) continue;

    out.set(name, {
      repo,
      url: repo ? githubUrl(repo, subPath) : null,
      evidence: evidence ?? "manual",
      installedAt: lock?.installedAt ?? plug?.installedAt ?? null,
      vendor,
      // hub 记录的 identifier（如 `official/security/1password`）在无公网 repo 时是唯一线索
      identifier: repo ? null : (hubHit?.identifier ?? null),
    });
  }
  return out;
}
