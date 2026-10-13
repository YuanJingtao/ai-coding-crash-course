/** Parsed Log 契约 —— 与 server/src/types.ts 保持同构 */

export interface KV {
  key: string;
  value: string;
}

export interface Stats {
  lines: number;
  chars: number;
}

export interface HeaderEntry {
  key: string;
  value: string;
  redacted: boolean;
}

/** 技能列表注入中规范化解析出的单个技能（`- name: description`） */
export interface SkillEntry {
  name: string;
  /** 描述（可能多行）；纯名字条目（如 `- xlsx`）为 null */
  description: string | null;
  /** 纯名字条目 = 占位技能（Placeholder Skill，见 CONTEXT.md；仍占据注入体积） */
  placeholder: boolean;
  /** 该条目注入原文的字符数（含 `- ` 前缀与换行），用于 token 估算 */
  chars: number;
  /** 校准 token 估算（未归一化） */
  estTokens: number;
}

export type MessageBlock =
  | {
      type: "system-reminder";
      summary: string;
      markdown: string;
      stats: Stats;
      /** 该注入块是技能列表时的规范化解析结果；其余注入块为 null */
      skills: SkillEntry[] | null;
    }
  | { type: "user-text"; markdown: string; stats: Stats };

export interface ParsedMessage {
  index: number;
  role: string;
  blocks: MessageBlock[];
  reminderCount: number;
  stats: Stats;
}

export interface ToolEntry {
  name: string;
  summary: string;
  markdown: string;
  stats: Stats;
  /** 校准 token 估算（未归一化） */
  estTokens: number;
  /** 归一化后的 tokens（与 Skills / 四分类同口径） */
  tokens: number;
}

export interface Usage {
  billable?: boolean;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  credits?: number;
}

export interface OtherFields {
  json: unknown;
  raw: string;
  duplicateInjection: boolean;
  duplicateChars: number;
}

export interface Section<T> {
  data: T;
  stats: Stats;
}

/** 上下文四分类之一（对齐 qodercli /context 面板的分类法，数值为 wire 真值口径） */
export interface ContextCategoryStats {
  key: "system-prompt" | "system-tools" | "skills" | "messages";
  label: string;
  chars: number;
  /** 校准启发式估算（未归一化） */
  estTokens: number;
  /** 显示值：有 usage 锚 = 估算 × 归一化系数；无锚 = round(estTokens) */
  tokens: number;
  /** 占上下文窗口百分比（2 位小数）；contextLength 缺失时为 null */
  percent: number | null;
}

/** 技能作用域（/context 四组；unknown = 扫盘反推不可用） */
export type SkillScope = "project" | "user" | "plugin" | "builtin" | "unknown";

/** 技能来源（安装/获得渠道），与 Scope 正交；人工考证维护于 server/skill-sources.json —— 与 server 同构 */
export type SkillSource =
  | "aone"
  | "npx"
  | "plugin"
  | "builtin"
  | "official"
  | "personal"
  | "unknown";

/** 扫盘反推的技能位置：作用域 + 含 SKILL.md 的目录绝对路径 */
export interface SkillLocation {
  scope: SkillScope;
  dir: string;
}

/** Skills 明细中的一条（规范技能列表 = 最大的一份注入实例） */
export interface SkillShareEntry {
  name: string;
  placeholder: boolean;
  chars: number;
  estTokens: number;
  /** 归一化后的 tokens */
  tokens: number;
  /** 占 Skills 类别份额（%，1 位小数）——分母为注入列表而非列出列表 */
  sharePercent: number;
  /** 解析期扫盘反推；project 目录来自 skill-roots.json */
  scope: SkillScope;
  /** 扫盘反推的技能目录（含 SKILL.md 的绝对路径）；builtin/unknown 为 null */
  path: string | null;
  /** 注入条目携带的描述；占位技能为 null */
  description: string | null;
  /** wire 无描述时的磁盘兜底（SKILL.md frontmatter）；有 wire 描述或无目录时为 null */
  diskDescription: string | null;
  /** 用户手动分类的 id；name→categoryId 全局映射，跨日志生效。未归类为 null（进未分类收件箱） */
  categoryId: string | null;
  /** 技能来源；来自 server/skill-sources.json 全局映射，未收录为 null */
  source: SkillSource | null;
}

/** 分类色板（与 web/src/index.css 的 6 色 neon 一一对应）——与 server 同构 */
export type SkillCategoryColor =
  | "neon-cyan"
  | "neon-amber"
  | "neon-purple"
  | "neon-green"
  | "neon-red"
  | "neon-blue";

/** 用户自定义的一个技能分类（"这个技能是干什么用的"） */
export interface SkillCategory {
  id: string;
  label: string;
  color: SkillCategoryColor;
  order: number;
  /** 父分类 id；null = 顶级。分类是一棵树，技能挂在任一节点上 */
  parentId: string | null;
}

/** 技能分类档（server/skill-categories.json）——与 server 同构 */
export interface SkillCategoriesDoc {
  categories: SkillCategory[];
  assignments: Record<string, string>;
}

/** /context 式上下文占用统计（派生视图，wire 真值口径） */
export interface ContextStats {
  /** params.context_length —— 真上限（model-config.max_input_tokens 不是） */
  contextLength: number | null;
  /** usage.prompt_tokens —— 服务端真值 */
  promptTokens: number | null;
  /** 归一化锚：usage = 服务端真值锚定；estimate = 纯本地估算 */
  anchor: "usage" | "estimate";
  model: string | null;
  usedTokens: number;
  usedPercent: number | null;
  freeTokens: number | null;
  freePercent: number | null;
  categories: ContextCategoryStats[];
  /** 按作用域分组（project > user > plugin > builtin > unknown）、组内份额降序 */
  skills: SkillShareEntry[];
  /** 技能列表注入出现的消息实例数（多轮对话会重复注入，全部计入 Skills 占用） */
  skillListInstances: number;
}

export interface ParsedLog {
  id: string;
  fileName: string;
  meta: KV[];
  headers: HeaderEntry[];
  request: {
    params: KV[];
    modelConfig: KV[];
    systemPrompt: Section<string> | null;
    tools: { entries: ToolEntry[]; intro: string | null; stats: Stats } | null;
    messages: ParsedMessage[];
    messagesStats: Stats | null;
    otherFields: OtherFields | null;
  };
  response: {
    finishReason: string | null;
    usage: Usage | null;
    extras: KV[];
    thinking: Section<string> | null;
    assistantText: Section<string> | null;
    stats: Stats;
  } | null;
  derived: {
    totalLines: number;
    totalChars: number;
    reminderCount: number;
    reminderChars: number;
    utteranceChars: number;
    injectionRatio: number | null;
    toolCount: number;
    /** 技能列表注入中解析出的技能数（无技能注入时为 0） */
    skillCount: number;
    /** 其中占位技能（纯名字条目）的数量 */
    skillPlaceholderCount: number;
    cacheHitRate: number | null;
  };
  /** /context 式上下文占用统计（wire 真值口径） */
  context: ContextStats;
  parseWarnings: string[];
}

/** 一份 Wire 日志的角色分类（见 CONTEXT.md：主对话请求 / 辅助请求） */
export type LogKind = "main" | "auxiliary";

export interface LogListItem {
  id: string;
  fileName: string;
  size: number;
  mtime: string;
  timestamp: string | null;
  agent: string | null;
  kind: LogKind;
  /** 辅助请求的子任务名（title_generation / prompt_suggestion 等）；仅 auxiliary 有意义 */
  auxTask: string | null;
}

export interface LogDetailResponse {
  ok: boolean;
  log?: ParsedLog;
  parseError?: string;
  raw?: string;
}
