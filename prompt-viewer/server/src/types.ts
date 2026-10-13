/** Prompt Viewer 领域模型 —— 与 web/src/types.ts 保持同构（Parsed Log 契约） */

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
  /** 校准 token 估算（见 estimateTokens；未归一化） */
  estTokens: number;
}

export type MessageBlock =
  | {
      type: "system-reminder";
      /** 首行摘要（去除 markdown 记号） */
      summary: string;
      markdown: string;
      stats: Stats;
      /** 该注入块是技能列表时的规范化解析结果；其余注入块为 null */
      skills: SkillEntry[] | null;
    }
  | {
      type: "user-text";
      markdown: string;
      stats: Stats;
    };

export interface ParsedMessage {
  index: number;
  role: string;
  blocks: MessageBlock[];
  reminderCount: number;
  stats: Stats;
}

export interface ToolEntry {
  name: string;
  /** 首段描述摘要 */
  summary: string;
  markdown: string;
  stats: Stats;
  /** 校准 token 估算（未归一化），见 CONTEXT.md「校准 token 估算」 */
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
  /** chat_context.text 与 system-reminder 内容重复注入 */
  duplicateInjection: boolean;
  duplicateChars: number;
}

export interface Section<T> {
  data: T;
  stats: Stats;
}

/** 上下文四分类之一（对齐 qodercli /context 面板的分类法，但数值为 wire 真值口径） */
export interface ContextCategoryStats {
  key: "system-prompt" | "system-tools" | "skills" | "messages";
  label: string;
  chars: number;
  /** 校准启发式估算（未归一化），见 CONTEXT.md「校准 token 估算」 */
  estTokens: number;
  /** 显示值：有 usage 锚 = 估算 × 归一化系数；无锚 = round(estTokens) */
  tokens: number;
  /** 占上下文窗口百分比（2 位小数）；contextLength 缺失时为 null */
  percent: number | null;
}

/** 技能作用域（/context 四组；unknown = 扫盘反推不可用） */
export type SkillScope = "project" | "user" | "plugin" | "builtin" | "unknown";

/**
 * 技能来源（**获得渠道**：我从哪条路拿到这个技能），与 Scope（归属层级）正交，
 * 也与 SkillVendor（上游作者）正交——同一技能可以是「从 Aone 市场下的」且「Anthropic 写的」：
 * aone = Aone 技能市场（a1 skill get 可查到且 desc 一致，或确认为市场升级导致的 desc 漂移）；
 * npx = skills CLI 安装（`skills-lock.json` / `.skill-lock.json` 有记录）；
 * plugin = qodercli 插件市场（wire 名带 `plugin:skill` 前缀）；
 * builtin = qodercli 内置；manual = 手动放置（拷进技能目录，无安装凭据可查）；
 * personal = 个人创建；unknown = 已删除等无法考证。
 * 人工考证维护于 server/skill-sources.json（name→source 全局映射），查不到为 null。
 *
 * 注：曾经有一档 `official`，它表达的其实是「上游作者」而非渠道，与 vendor 维度重复，已废弃。
 */
export type SkillSource =
  | "aone"
  | "npx"
  | "plugin"
  | "builtin"
  | "manual"
  | "personal"
  | "unknown";

/**
 * 技能作者归属（**上游是谁写的**），与 SkillSource（我怎么拿到的）正交。
 * 由出处 repo 的 owner 经 FIRST_PARTY_ORGS 判定：命中第一方 org = 对应厂商官方，
 * 其余（个人/社区作者，如 JimLiu、mattpocock）= community（公版）。
 * 内部包等无公网 repo 的靠 skill-sources.json 的 `vendors` 段人工指定（如 dws → alibaba）。
 */
export type SkillVendor = "anthropic" | "vercel" | "alibaba" | "qoder" | "community";

/**
 * 技能出处凭据（扫注册表解析，见 skillProvenance.ts）。
 * evidence 决定可信度，UI 必须区分展示：
 * install-record = 本机安装凭据（skills CLI lock / hermes hub lock），确凿；
 * catalog-match = 上游目录同名条目，只证明「有个同名技能在那个 repo」，同名不同源会误判；
 * manual = 仅有 skill-sources.json 的人工 vendor 指定，无 repo 凭据。
 */
export interface SkillProvenance {
  /** 上游仓库 `owner/repo`；无公网 repo 为 null */
  repo: string | null;
  /** 可点击出处（GitHub 目录页）；无公网 repo 为 null */
  url: string | null;
  evidence: "install-record" | "catalog-match" | "manual";
  /** 安装时间（仅 skills CLI v3 lock 有）；无则 null */
  installedAt: string | null;
  /** 上游作者归属；无法判定为 null */
  vendor: SkillVendor | null;
  /** 无公网 repo 时的替代线索（hermes identifier，如 `official/security/1password`） */
  identifier: string | null;
}

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
  /** 占 Skills 类别份额（%，1 位小数）——与 /context Skills 页同语义（分母为注入列表而非列出列表） */
  sharePercent: number;
  /** 解析期扫盘反推（见 skillScopes.ts）；project 目录来自 skill-roots.json */
  scope: SkillScope;
  /** 扫盘反推的技能目录（含 SKILL.md 的绝对路径）；builtin/unknown 为 null */
  path: string | null;
  /** 注入条目携带的描述；占位技能为 null */
  description: string | null;
  /**
   * 磁盘兜底描述：wire 未注入描述（占位技能）时，从技能目录 SKILL.md frontmatter 读取。
   * 仅当 description 为 null 且扫盘有目录时才可能有值；builtin 恒为 null。
   * 前端以弱化样式展示并标注来源，与 wire 真值区分。
   */
  diskDescription: string | null;
  /**
   * 用户手动分类的 id（见 SkillCategoriesDoc）；name→categoryId 的全局映射，
   * 跨日志生效（同名技能在任何日志里都套同一分类）。未归类为 null（进未分类收件箱）。
   */
  categoryId: string | null;
  /** 技能来源（获得渠道，见 SkillSource）；来自 server/skill-sources.json 全局映射，未收录为 null */
  source: SkillSource | null;
  /**
   * 出处凭据（上游 repo / 可点击地址 / 作者归属 / 证据强度），解析期扫注册表所得。
   * 无任何凭据且无人工 vendor 指定时为 null。结果依赖解析机器，见 skillProvenance.ts。
   */
  provenance: SkillProvenance | null;
}

/** 分类色板（与 web/src/index.css 的 6 色 neon 一一对应） */
export type SkillCategoryColor =
  | "neon-cyan"
  | "neon-amber"
  | "neon-purple"
  | "neon-green"
  | "neon-red"
  | "neon-blue";

/** 用户自定义的一个技能分类（"这个技能是干什么用的"） */
export interface SkillCategory {
  /** 稳定主键；改名只动 label，assignments 靠 id 引用故不丢归类 */
  id: string;
  label: string;
  color: SkillCategoryColor;
  /** 展示排序，升序（同级之间） */
  order: number;
  /** 父分类 id；null = 顶级。分类是一棵树，技能挂在任一节点上 */
  parentId: string | null;
}

/**
 * 技能分类档（server/skill-categories.json，gitignore，个人本地状态）。
 * 缺失/损坏时后端按空档处理，不报错。
 */
export interface SkillCategoriesDoc {
  categories: SkillCategory[];
  /** 技能 name → categoryId；不在其中的技能即未分类 */
  assignments: Record<string, string>;
}

/**
 * /context 式上下文占用统计（派生视图）。
 * 口径差异见 docs/context-panel-validation.md：
 * - 总量锚定服务端 usage.prompt_tokens（真值）；
 * - 分类/份额用校准估算再归一化；
 * - Skills 只含注入技能（不含 disable-model-invocation 的列出技能）；
 * - Autocompact 在 wire 中无对应字段，不产出。
 */
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
    /** 注入放大比 = reminderChars / utteranceChars（无法计算时为 null） */
    injectionRatio: number | null;
    toolCount: number;
    /** 技能列表注入中解析出的技能数（无技能注入时为 0） */
    skillCount: number;
    /** 其中占位技能（纯名字条目）的数量 */
    skillPlaceholderCount: number;
    cacheHitRate: number | null;
  };
  /** /context 式上下文占用统计（wire 真值口径，见 ContextStats） */
  context: ContextStats;
  parseWarnings: string[];
}

/** 一份 Wire 日志的角色分类（见 CONTEXT.md：主对话请求 / 辅助请求） */
export type LogKind = "main" | "auxiliary";

/** classifyWireLog 的产物；server 内部类型，不出现在 API 响应里 */
export interface LogClassification {
  kind: LogKind;
  /** 辅助请求的子任务名（title_generation / prompt_suggestion 等）；主对话或无法判定时为 null */
  auxTask: string | null;
}

export interface LogListItem {
  id: string;
  fileName: string;
  size: number;
  mtime: string;
  /** 从文件名解析出的时间戳 */
  timestamp: string | null;
  agent: string | null;
  kind: LogKind;
  /** 辅助请求的子任务名；仅 kind == "auxiliary" 时有意义 */
  auxTask: string | null;
}

export interface LogDetailResponse {
  ok: boolean;
  log?: ParsedLog;
  /** 解析失败时降级返回 */
  parseError?: string;
  raw?: string;
}
