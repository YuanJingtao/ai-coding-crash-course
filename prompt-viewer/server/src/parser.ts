/**
 * Wire 日志解析器
 *
 * 设计原则（见 CONTEXT.md）：
 * 1. 白名单解析 —— 只有 Wire 标签参与结构解析，且必须整行锚定（^<tag>$ / ^</tag>$）。
 *    工具文档等*内容*里出现的示例标签（Echo Tag，如 <EXTREMELY-IMPORTANT>）不会被误判。
 * 2. 语法感知 —— 按 wire 格式的文法在父段范围内查找子段，避免跨段误配。
 * 3. 容忍缺失 —— 小请求没有 tools / thinking 等段，缺了就置 null，不报错。
 */

import type {
  ContextCategoryStats,
  ContextStats,
  HeaderEntry,
  KV,
  LogClassification,
  MessageBlock,
  OtherFields,
  ParsedLog,
  ParsedMessage,
  Section,
  SkillEntry,
  SkillLocation,
  SkillShareEntry,
  SkillScope,
  SkillSource,
  Stats,
  ToolEntry,
  Usage,
} from "./types.js";

/** CJK（含部首扩展、中日标点、假名区段、兼容表意文字、全角形式）码位 */
const CJK_RE =
  /[\u2e80-\ua4cf\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/**
 * 校准 token 估算（见 CONTEXT.md）：CJK×0.6 + 其他÷4。
 * 对 Qwen 系 tokenizer 的混合中英文实测误差 ~2%（validation case：估 24.3k vs 真值 24,783）。
 * 仅用于段间比例分配；有 usage 时会被整体归一化到 prompt_tokens。
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (CJK_RE.test(ch)) cjk++;
  return cjk * 0.6 + (text.length - cjk) / 4;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

interface Block {
  /** 开标签行号（相对传入数组） */
  open: number;
  /** 闭标签行号（不含）；未闭合时为数组长度 */
  close: number;
  /** 开标签上的属性串，如 ` index="1" role="user"` */
  attrs: string;
}

function statsOf(lines: string[]): Stats {
  const text = lines.join("\n");
  return { lines: lines.length, chars: text.length };
}

function trimBlank(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && lines[s].trim() === "") s++;
  while (e > s && lines[e - 1].trim() === "") e--;
  return lines.slice(s, e);
}

/** 在 lines[from..] 中查找整行锚定的 <tag>...</tag> 块 */
function findBlock(lines: string[], tag: string, from = 0): Block | null {
  const openRe = new RegExp(`^<${tag}(\\s[^>]*)?>\\s*$`);
  const closeRe = new RegExp(`^</${tag}>\\s*$`);
  for (let i = from; i < lines.length; i++) {
    const m = lines[i].match(openRe);
    if (m) {
      for (let j = i + 1; j < lines.length; j++) {
        if (closeRe.test(lines[j])) return { open: i, close: j, attrs: m[1] ?? "" };
      }
      // 未闭合：容忍，取到末尾
      return { open: i, close: lines.length, attrs: m[1] ?? "" };
    }
  }
  return null;
}

function blockContent(lines: string[], b: Block): string[] {
  return trimBlank(lines.slice(b.open + 1, b.close));
}

/** 解析 `- **key**: value` 形式的 KV 列表 */
function parseKVList(lines: string[]): KV[] {
  const out: KV[] = [];
  for (const line of lines) {
    const m = line.match(/^-\s+\*\*(.+?)\*\*:\s*(.*)$/);
    if (m) out.push({ key: m[1].trim(), value: m[2].trim() });
  }
  return out;
}

/** 提取段内第一个 fenced code block 的内容 */
function extractFence(lines: string[], lang?: string): string[] | null {
  const openRe = lang ? new RegExp(`^\`\`\`${lang}\\s*$`) : /^```/;
  for (let i = 0; i < lines.length; i++) {
    if (openRe.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^```\s*$/.test(lines[j])) return lines.slice(i + 1, j);
      }
      return lines.slice(i + 1);
    }
  }
  return null;
}

function parseHeaders(lines: string[]): HeaderEntry[] {
  const fence = extractFence(lines);
  const src = fence ?? lines;
  const out: HeaderEntry[] = [];
  for (const line of src) {
    if (line.trim() === "") continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out.push({ key, value, redacted: value === "[REDACTED]" });
  }
  return out;
}

/** 去掉行内 markdown 记号，用于生成摘要 */
function stripInlineMd(s: string): string {
  return s
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .trim();
}

function summarize(lines: string[], max = 64): string {
  for (const line of lines) {
    const t = stripInlineMd(line);
    if (t) return t.length > max ? t.slice(0, max) + "…" : t;
  }
  return "(空)";
}

function parseTools(lines: string[]): { entries: ToolEntry[]; intro: string | null } {
  const entries: ToolEntry[] = [];
  let intro: string[] = [];
  let current: { name: string; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const body = trimBlank(current.body);
    const markdown = body.join("\n");
    entries.push({
      name: current.name,
      summary: summarize(body, 96),
      markdown,
      stats: statsOf(body),
      estTokens: Math.round(estimateTokens(markdown)),
      tokens: 0, // 归一化系数在解析后期才确定，由调用处回填
    });
    current = null;
  };

  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      flush();
      current = { name: stripInlineMd(m[1]), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      intro.push(line);
    }
  }
  flush();

  const introText = trimBlank(intro).join("\n");
  return { entries, intro: introText ? introText : null };
}

/** 技能列表注入的固定开头行（Claude Code / qoder 的 skill reminder 均以此起始） */
const SKILLS_HEADER_RE = /^The following skills are available for use with the Skill tool:\s*$/;

/**
 * 从 system-reminder 内容中规范化解析技能列表。
 * 条目形状：`- name: description`（description 可折行成多行）或纯 `- name`。
 * 注意 name 本身可含冒号（如 `claude-hud:setup`），因此按首个「冒号+空格」切分。
 * 不含技能列表头时返回 null（该注入块不是技能列表）。
 */
function parseSkillList(lines: string[]): SkillEntry[] | null {
  const headerIdx = lines.findIndex((l) => SKILLS_HEADER_RE.test(l.trim()));
  if (headerIdx === -1) return null;

  const skills: SkillEntry[] = [];
  let current: { name: string; desc: string[]; raw: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const desc = trimBlank(current.desc).join("\n");
    // 注入原文字符数：各源行长度 + 每行一个换行符
    const chars = current.raw.reduce((acc, l) => acc + l.length + 1, 0);
    skills.push({
      name: current.name,
      description: desc ? desc : null,
      placeholder: !desc, // 纯名字条目 = 占位技能（见 CONTEXT.md）
      chars,
      estTokens: estimateTokens(current.raw.join("\n")),
    });
    current = null;
  };

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // 条目间空行：容忍并跳过
    const m = line.match(/^-\s+(.+?)\s*$/);
    if (m) {
      flush();
      const text = m[1];
      const sep = text.indexOf(": ");
      current =
        sep > 0
          ? { name: text.slice(0, sep).trim(), desc: [text.slice(sep + 2)], raw: [line] }
          : { name: text.trim(), desc: [], raw: [line] };
    } else if (current) {
      // 描述折行：非 `- ` 开头的内容行归入当前条目
      current.desc.push(line.trim());
      current.raw.push(line);
    }
  }
  flush();
  return skills;
}

/**
 * 将 message 内容切分为「系统注入块」与「用户真实输入块」。
 * 只识别整行锚定的 <system-reminder>，块内容原样保留（Echo Tag 不解析）。
 * 特例：技能列表注入块会被规范化解析出 skills（见 parseSkillList）。
 */
function splitMessageBlocks(lines: string[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let pending: string[] = [];

  const flushPending = () => {
    const content = trimBlank(pending);
    pending = [];
    if (content.length === 0) return;
    blocks.push({
      type: "user-text",
      markdown: content.join("\n"),
      stats: statsOf(content),
    });
  };

  let i = 0;
  while (i < lines.length) {
    if (/^<system-reminder>\s*$/.test(lines[i])) {
      flushPending();
      let j = i + 1;
      while (j < lines.length && !/^<\/system-reminder>\s*$/.test(lines[j])) j++;
      const content = trimBlank(lines.slice(i + 1, Math.min(j, lines.length)));
      blocks.push({
        type: "system-reminder",
        summary: summarize(content),
        markdown: content.join("\n"),
        stats: statsOf(content),
        skills: parseSkillList(content),
      });
      i = j + 1;
    } else {
      pending.push(lines[i]);
      i++;
    }
  }
  flushPending();
  return blocks;
}

function parseMessage(lines: string[], b: Block): ParsedMessage {
  const idx = b.attrs.match(/index="(\d+)"/);
  const role = b.attrs.match(/role="([\w-]+)"/);
  const content = blockContent(lines, b);
  const blocks = splitMessageBlocks(content);
  return {
    index: idx ? Number(idx[1]) : 0,
    role: role ? role[1] : "unknown",
    blocks,
    reminderCount: blocks.filter((x) => x.type === "system-reminder").length,
    stats: statsOf(content),
  };
}

function parseOtherFields(lines: string[]): OtherFields | null {
  const fence = extractFence(lines, "json");
  const raw = fence ? fence.join("\n") : lines.join("\n");
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // 保留 raw，前端降级为纯文本
  }
  let duplicateChars = 0;
  if (json && typeof json === "object") {
    const ctx = (json as Record<string, unknown>).chat_context;
    if (ctx && typeof ctx === "object") {
      const text = (ctx as Record<string, unknown>).text;
      if (typeof text === "string") duplicateChars = text.length;
    }
  }
  return { json, raw, duplicateInjection: duplicateChars > 1000, duplicateChars };
}

function sectionOf(markdown: string | null): Section<string> | null {
  if (markdown === null) return null;
  const lines = markdown.split("\n");
  return { data: markdown, stats: statsOf(lines) };
}

export function parseWireLog(
  id: string,
  fileName: string,
  text: string,
  scopeIndex: Map<string, SkillLocation> = new Map(),
  categoryIndex: Map<string, string> = new Map(),
  /** 技能来源映射（server/skill-sources.json，人工考证）；未收录为 null */
  sourceIndex: Map<string, SkillSource> = new Map(),
  /** 磁盘兜底描述读取器（注入，保持本模块不碰 fs）；仅 wire 无描述且有目录时调用 */
  diskDescriptionOf: (dir: string) => string | null = () => null,
): ParsedLog {
  const lines = text.split("\n");
  const warnings: string[] = [];

  const metaBlock = findBlock(lines, "meta");
  const headersBlock = findBlock(lines, "headers");
  const requestBlock = findBlock(lines, "request");
  const responseBlock = findBlock(lines, "response");
  if (!requestBlock) warnings.push("缺少 <request> 段");

  // ---- meta / headers ----
  const meta = metaBlock ? parseKVList(blockContent(lines, metaBlock)) : [];
  const headers = headersBlock ? parseHeaders(blockContent(lines, headersBlock)) : [];

  // ---- request 子段（限定在 request 范围内查找） ----
  const reqLines = requestBlock ? blockContent(lines, requestBlock) : [];
  const paramsBlock = findBlock(reqLines, "params");
  const modelConfigBlock = findBlock(reqLines, "model-config");
  const systemPromptBlock = findBlock(reqLines, "system-prompt");
  const toolsBlock = findBlock(reqLines, "tools");
  const messagesBlock = findBlock(reqLines, "messages");
  const otherFieldsBlock = findBlock(reqLines, "other-fields");

  const params = paramsBlock ? parseKVList(blockContent(reqLines, paramsBlock)) : [];
  const modelConfig = modelConfigBlock
    ? parseKVList(blockContent(reqLines, modelConfigBlock))
    : [];
  const systemPrompt = systemPromptBlock
    ? sectionOf(blockContent(reqLines, systemPromptBlock).join("\n"))
    : null;

  let tools: ParsedLog["request"]["tools"] = null;
  let toolsChars = 0;
  let toolsEst = 0;
  if (toolsBlock) {
    const content = blockContent(reqLines, toolsBlock);
    const parsed = parseTools(content);
    tools = { entries: parsed.entries, intro: parsed.intro, stats: statsOf(content) };
    const toolsText = content.join("\n");
    toolsChars = toolsText.length;
    toolsEst = estimateTokens(toolsText);
  }

  const messages: ParsedMessage[] = [];
  let messagesStats: Stats | null = null;
  if (messagesBlock) {
    const content = blockContent(reqLines, messagesBlock);
    messagesStats = statsOf(content);
    let cursor = 0;
    for (;;) {
      const mb = findBlock(content, "message", cursor);
      if (!mb) break;
      messages.push(parseMessage(content, mb));
      cursor = mb.close + 1;
    }
  }

  const otherFields = otherFieldsBlock
    ? parseOtherFields(blockContent(reqLines, otherFieldsBlock))
    : null;

  // ---- response ----
  let response: ParsedLog["response"] = null;
  if (responseBlock) {
    const content = blockContent(lines, responseBlock);
    let finishReason: string | null = null;
    let usage: Usage | null = null;
    const extras: KV[] = [];
    for (const line of content) {
      const fm = line.match(/^-\s+\*\*finish reason\*\*:\s*(.+)$/);
      if (fm) finishReason = fm[1].trim();
      const um = line.match(/^-\s+\*\*usage\*\*:\s*(.+)$/);
      if (um) {
        try {
          const u = JSON.parse(um[1].trim()) as Record<string, unknown>;
          const num = (o: unknown, k: string): number | undefined => {
            const v = o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
            return typeof v === "number" ? v : undefined;
          };
          // wire 格式里 cached/reasoning 嵌套在 *_tokens_details 中，展平到 Usage
          usage = {
            billable: typeof u.billable === "boolean" ? u.billable : undefined,
            prompt_tokens: num(u, "prompt_tokens"),
            completion_tokens: num(u, "completion_tokens"),
            total_tokens: num(u, "total_tokens"),
            credits: num(u, "credits"),
            cached_tokens: num(u.prompt_tokens_details, "cached_tokens"),
            reasoning_tokens: num(u.completion_tokens_details, "reasoning_tokens"),
          };
        } catch {
          warnings.push("usage JSON 解析失败");
        }
      }
    }
    for (const kv of parseKVList(content)) {
      if (kv.key !== "finish reason" && kv.key !== "usage") extras.push(kv);
    }
    const thinkingBlock = findBlock(content, "thinking");
    const assistantBlock = findBlock(content, "assistant-text");
    response = {
      finishReason,
      usage,
      extras,
      thinking: thinkingBlock
        ? sectionOf(blockContent(content, thinkingBlock).join("\n"))
        : null,
      assistantText: assistantBlock
        ? sectionOf(blockContent(content, assistantBlock).join("\n"))
        : null,
      stats: statsOf(content),
    };
  }

  // ---- 派生指标 ----
  let reminderCount = 0;
  let reminderChars = 0;
  let utteranceChars = 0;
  let skillCount = 0;
  let skillPlaceholderCount = 0;
  // /context 分类累计（wire 真值口径，见 docs/context-panel-validation.md）
  let skillListInstances = 0;
  let skillsChars = 0;
  let skillsEst = 0;
  let messagesChars = 0;
  let messagesEst = 0;
  let canonicalSkills: SkillEntry[] = [];
  for (const msg of messages) {
    reminderCount += msg.reminderCount;
    for (const blk of msg.blocks) {
      if (blk.type === "system-reminder") {
        reminderChars += blk.stats.chars;
        if (blk.skills) {
          // 技能列表注入 → Skills 类别；多轮对话会重复注入，实例全部计入占用
          skillListInstances++;
          skillsChars += blk.stats.chars;
          skillsEst += estimateTokens(blk.markdown);
          // 规范列表 = 最大的一份注入实例（用于 per-skill 份额明细）
          if (blk.skills.length > skillCount) {
            skillCount = blk.skills.length;
            skillPlaceholderCount = blk.skills.filter((s) => s.placeholder).length;
            canonicalSkills = blk.skills;
          }
        } else {
          messagesChars += blk.stats.chars;
          messagesEst += estimateTokens(blk.markdown);
        }
      } else {
        messagesChars += blk.stats.chars;
        messagesEst += estimateTokens(blk.markdown);
        // 剔除缓存断点标记后统计用户真实输入
        const pure = blk.markdown
          .split("\n")
          .filter((l) => !/^<!--\s*cache_control breakpoint\s*-->\s*$/.test(l))
          .join("\n")
          .trim();
        utteranceChars += pure.length;
      }
    }
  }
  const usage = response?.usage ?? null;
  const cacheHitRate =
    usage && usage.prompt_tokens && usage.cached_tokens !== undefined
      ? Math.round((usage.cached_tokens / usage.prompt_tokens) * 1000) / 10
      : null;

  const derived = {
    totalLines: lines.length,
    totalChars: text.length,
    reminderCount,
    reminderChars,
    utteranceChars,
    injectionRatio: utteranceChars > 0 ? Math.round(reminderChars / utteranceChars) : null,
    toolCount: tools?.entries.length ?? 0,
    skillCount,
    skillPlaceholderCount,
    cacheHitRate,
  };

  // ---- /context 式上下文占用统计（ContextStats） ----
  // 总量锚定服务端 usage.prompt_tokens（真值）；分类/份额用校准估算再整体归一化。
  // Autocompact 在 wire 中无对应字段，不产出（前端显示 N/A）。
  const promptTokens = usage?.prompt_tokens ?? null;
  const anchor: ContextStats["anchor"] = promptTokens !== null ? "usage" : "estimate";
  const spChars = systemPrompt?.stats.chars ?? 0;
  const spEst = systemPrompt ? estimateTokens(systemPrompt.data) : 0;
  const estTotal = spEst + toolsEst + skillsEst + messagesEst;
  const scale = promptTokens !== null && estTotal > 0 ? promptTokens / estTotal : 1;
  const usedTokens = promptTokens ?? Math.round(estTotal);
  // 回填每工具归一化 tokens（parseTools 阶段 scale 尚不可知）
  if (tools) {
    tools = {
      ...tools,
      entries: tools.entries.map((e) => ({ ...e, tokens: Math.round(e.estTokens * scale) })),
    };
  }

  // 真上限取 params.context_length（model-config.max_input_tokens 不是，见 CONTEXT.md）
  const ctxLenRaw = params.find((p) => p.key === "context_length")?.value;
  const ctxLenNum = ctxLenRaw !== undefined ? Number(ctxLenRaw.replace(/[_,\s]/g, "")) : NaN;
  const contextLength = Number.isFinite(ctxLenNum) && ctxLenNum > 0 ? ctxLenNum : null;
  const pct = (tokens: number): number | null =>
    contextLength !== null ? round2((tokens / contextLength) * 100) : null;

  const model =
    modelConfig.find((m) => m.key === "display_name")?.value ??
    meta.find((m) => m.key === "model")?.value ??
    null;

  const categories: ContextCategoryStats[] = (
    [
      { key: "system-prompt", label: "System prompt", chars: spChars, est: spEst },
      { key: "system-tools", label: "System tools", chars: toolsChars, est: toolsEst },
      { key: "skills", label: "Skills", chars: skillsChars, est: skillsEst },
      { key: "messages", label: "Messages", chars: messagesChars, est: messagesEst },
    ] as const
  ).map((c) => {
    const tokens = Math.round(c.est * scale);
    return {
      key: c.key,
      label: c.label,
      chars: c.chars,
      estTokens: Math.round(c.est),
      tokens,
      percent: pct(tokens),
    };
  });

  // per-skill 份额：分母为规范注入列表（与 /context 同语义，但只含注入技能）
  const shareTotal = canonicalSkills.reduce((acc, s) => acc + s.estTokens, 0);
  // 作用域反推（扫盘）；索引为空（目录全缺失）时整体归 unknown，不硬猜
  const scopesUsable = scopeIndex.size > 0;
  const locOf = (name: string) => (scopesUsable ? scopeIndex.get(name) : undefined);
  const scopeOf = (name: string): SkillScope =>
    scopesUsable ? (scopeIndex.get(name)?.scope ?? "builtin") : "unknown";
  const SCOPE_ORDER: Record<SkillScope, number> = { project: 0, user: 1, builtin: 2, unknown: 3 };
  const skillShares: SkillShareEntry[] = canonicalSkills
    .map((s) => {
      const loc = locOf(s.name);
      return {
        name: s.name,
        placeholder: s.placeholder,
        chars: s.chars,
        estTokens: Math.round(s.estTokens),
        tokens: Math.round(s.estTokens * scale),
        sharePercent: shareTotal > 0 ? round1((s.estTokens / shareTotal) * 100) : 0,
        scope: scopeOf(s.name),
        path: loc?.dir ?? null,
        description: s.description,
        diskDescription:
          s.description === null && loc ? (diskDescriptionOf(loc.dir) ?? null) : null,
        categoryId: categoryIndex.get(s.name) ?? null,
        source: sourceIndex.get(s.name) ?? null,
      };
    })
    .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || b.tokens - a.tokens);

  const freeTokens = contextLength !== null ? Math.max(contextLength - usedTokens, 0) : null;
  const context: ContextStats = {
    contextLength,
    promptTokens,
    anchor,
    model,
    usedTokens,
    usedPercent: pct(usedTokens),
    freeTokens,
    freePercent: freeTokens !== null ? pct(freeTokens) : null,
    categories,
    skills: skillShares,
    skillListInstances,
  };

  return {
    id,
    fileName,
    meta,
    headers,
    request: { params, modelConfig, systemPrompt, tools, messages, messagesStats, otherFields },
    response,
    derived,
    context,
    parseWarnings: warnings,
  };
}

/**
 * 把一份 wire 日志分类为「主对话请求」或「辅助请求」（见 CONTEXT.md）。
 *
 * 判别级联，命中即返回：
 * 1. 主判据 —— `<request>` 下 `<other-fields>` 里的顶层 `task_id`（整行锚定 + 语法感知，
 *    工具文档 schema 里的对象形式 `"task_id": {` 是 Echo 内容，不会误中）：
 *      - `task_id === "common"` → main（Qoder 主对话 agent 的固定标记）；
 *      - 存在且 `!== "common"`（如 `agent_summary`）→ auxiliary，`auxTask` 取
 *        `business.sub_task`（缺省退回 `business.name`），如 `title_generation` /
 *        `prompt_suggestion`。未来 Qoder 新增辅助任务只要不走 common 就自动归入此类。
 * 2. 降级判据 —— other-fields 缺失或 task_id 取不到时，看 `<meta>` 的 `**model**:`：
 *    Qoder 辅助请求固定走 `lite` 小模型，故 `model === "lite"` → auxiliary，否则 main。
 * 3. 两级都失败 —— fail-open 归为 main：误藏真主对话的代价（用户以为丢数据）高于
 *    多显示一条身份不明文件的代价（点开即可辨认）。
 */
export function classifyWireLog(text: string): LogClassification {
  const lines = text.split("\n");

  // ---- 1. 主判据：other-fields.task_id ----
  const requestBlock = findBlock(lines, "request");
  if (requestBlock) {
    const reqLines = blockContent(lines, requestBlock);
    const otherFieldsBlock = findBlock(reqLines, "other-fields");
    if (otherFieldsBlock) {
      const parsed = parseOtherFields(blockContent(reqLines, otherFieldsBlock));
      const json = parsed?.json;
      if (json && typeof json === "object") {
        const obj = json as Record<string, unknown>;
        const taskId = obj.task_id;
        if (typeof taskId === "string" && taskId !== "") {
          if (taskId === "common") return { kind: "main", auxTask: null };
          let auxTask: string | null = null;
          const business = obj.business;
          if (business && typeof business === "object") {
            const b = business as Record<string, unknown>;
            if (typeof b.sub_task === "string" && b.sub_task !== "") auxTask = b.sub_task;
            else if (typeof b.name === "string" && b.name !== "") auxTask = b.name;
          }
          return { kind: "auxiliary", auxTask };
        }
      }
    }
  }

  // ---- 2. 降级判据：meta.model ----
  const metaBlock = findBlock(lines, "meta");
  if (metaBlock) {
    const model = parseKVList(blockContent(lines, metaBlock)).find((kv) => kv.key === "model");
    if (model && model.value !== "") {
      return model.value === "lite"
        ? { kind: "auxiliary", auxTask: null }
        : { kind: "main", auxTask: null };
    }
  }

  // ---- 3. fail-open ----
  return { kind: "main", auxTask: null };
}
