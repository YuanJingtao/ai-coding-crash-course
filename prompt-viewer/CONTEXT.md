# CONTEXT — Prompt Viewer 领域词汇表

本文件只做词汇表（Glossary），不含实现细节。

| 术语 | 英文 / 标识 | 定义 |
|---|---|---|
| Wire 日志 | Wire Log | request-logger 抓包后归一化输出的 `.md` 文件，用 XML 风格标签组织一次完整的 LLM HTTP 交互（请求 + 响应）。 |
| Wire 标签 | Wire Tag | 构成日志骨架的白名单标签：`meta` / `headers` / `request` / `params` / `model-config` / `system-prompt` / `tools` / `messages` / `message` / `other-fields` / `response` / `thinking` / `assistant-text`。**仅此白名单参与结构解析**。 |
| 示例标签 | Echo Tag | 出现在 system-prompt / tools 文档*内容里*的标签（如 `<EXTREMELY-IMPORTANT>`、`<SUBAGENT-STOP>`、`<task-notification>`）。它们是数据不是结构，一律按字面内容渲染，不得参与结构解析。 |
| 段 | Section | 一个顶层 Wire 标签及其内容，是 UI 上的一张可折叠卡片。段可以缺失（小请求没有 `tools` / `thinking`），解析器必须容忍。 |
| 系统注入 | System Injection | `<system-reminder>` 块：运行时塞进 user 消息的系统级上下文（MCP 说明、技能列表、当前日期等），与用户真实输入语义完全不同。 |
| 技能列表注入 | Skill Injection | 以 `The following skills are available for use with the Skill tool:` 起始的系统注入块，被规范化解析为技能条目列表；其余注入块仍按纯文本对待。 |
| 技能条目 | Skill Entry | 技能列表中的一行 `- name: description`：名字按首个「冒号+空格」切分（名字本身可含冒号，如 `plugin:skill`），描述可折行成多段，纯名字条目描述为 null。 |
| 占位技能 | Placeholder Skill | 技能列表中的纯名字条目（无描述）：技能声明了 `disable-model-invocation`，模型不能主动调用，但条目本身仍随每次请求注入、占据 token 体积。（旧称"禁用技能"已废弃——"禁用"专指在设置中被整体关闭、根本不出现在列表里的技能。） |
| 磁盘兜底描述 | Disk Fallback Description | 占位技能（wire 只注入名字、无描述）时，Viewer 从技能目录 `SKILL.md` frontmatter 读取的 description，以弱化样式 + 💾 标注来源展示，与 wire 真值描述区分。Built-in 技能磁盘无目录，无兜底，仍显示"—"。 |
| 列出技能 | Listed Skill | qodercli `/context` Skills 页展示的全部技能。列出数 ≥ 注入数：差值是标记 `disable-model-invocation: true` 的技能，它们只能由用户手动调用，零 token 成本、不进 wire。Viewer 明细表以注入列表为主体，另按当前二进制内嵌名单合成 `listedOnly` 行（只列不注入）以复现 /context 的 Built-in 组。**已知缺口**：/context 的 Built-in 组还会列出被 User 目录遮蔽的同名内置（`shadowed [shadowed by User]`，如 deep-research / skill-creator），它们走另一条注册路径、二进制里抽不到，Viewer 仍按磁盘归 User。 |
| 注入技能 | Injected Skill | 实际出现在 wire 技能列表注入中的技能。只有注入技能消耗 token；上下文面板中 Skills 份额的分母是注入列表而非列出列表。 |
| 技能作用域 | Skill Scope | 技能的归属层级，对齐 qodercli `/skills` 的四组：Project（qodercli 发起目录下 `.qoder/skills`、`.agents/skills`、`.claude/skills` 的技能，含指向用户级目录的符号链接；**以及项目级文件型 slash command** `.qoder/commands/*.md`、`.claude/commands/*.md`）、User（用户级技能目录 `~/.qoder/skills` 等；**以及用户级文件型 slash command** `~/.qoder/commands/*.md`——单文件 command 若不扫会被残余启发式误归 Built-in，create-command 一案）、Plugin（插件注册表 `installed_plugins_v2.json` + 缓存目录扫描，以 `pluginName:skillName` 命名空间索引，与 wire 注入名一致）、Built-in（qodercli 内嵌：以**当前二进制内嵌名单** `registerBundledSkill` 为准补「只列不注入」行，其余查不到来源的名字归 Built-in 残余启发式）。wire 注入列表不携带作用域字段；Viewer 在解析期扫盘 best-effort 反推，同名技能按 project > user 取先命中者，扫盘不可用时标为 unknown。 |
| 技能来源 | Skill Source | 技能的**获得渠道**（我怎么拿到的），与作用域、技能作者三者正交：aone（Aone 技能市场下载；`a1 skill get` 可查到且 desc 一致，或 desc 差异确认为市场/本地升级所致）、npx（skills CLI 安装，`skills-lock.json` / `.skill-lock.json` 有记录）、plugin（qodercli 插件市场，wire 名带 `plugin:skill` 前缀）、builtin（qodercli 内置）、manual（手动放置到技能目录，无安装凭据可查）、personal（个人创建）、unknown（已删除等无法考证）。渠道是**人工考证**结论，存于 `server/skill-sources.json`（name→source 全局映射，gitignore，只读无 API 写路径）；未收录显示「—」。历史上曾有一档 `official`，它表达的其实是「上游作者」而非渠道，与技能作者维度重复，已废弃并迁移。 |
| 技能作者 | Skill Vendor | 技能的**上游归属**（谁写的），与获得渠道正交——同一技能可以是「从 Aone 市场下的」（source=aone）且「Anthropic 写的」（vendor=anthropic）。第一方厂商显示「官方·<厂商>」（anthropic / vercel / alibaba / qoder），个人与社区公开包统一显示「公版」（community）。由出处 repo 的 owner 经第一方 org 表自动判定；内部包等无公网 repo 的靠 `skill-sources.json` 的 `vendors` 段人工指定（如 `dws`：Apache-2.0 + NOTICE 证明是钉钉官方）。判不出显示「—」。 |
| 出处凭据 | Skill Provenance | 解析期扫本机注册表得到的出处（`server/src/skillProvenance.ts`）：上游 repo、可点击 GitHub 地址、作者归属、证据强度。凭据分两档，UI 必须区分：`install-record` = 本机安装凭据（skills CLI 的 lock 文件、插件注册表 `installed_plugins_v2.json` + 插件 manifest 的 `repository` 字段、hermes hub lock），确凿，badge 实线边框；`catalog-match` = 上游技能目录（hermes hub index-cache）里的同名条目，只证明「有个同名技能在那个 repo」，同名不同源会误判，badge 虚线边框 + tooltip 说明。插件技能以 `pluginName:skillName` 命名空间索引——skills CLI 的 lock 只记裸名，匹配不到命名空间名，插件注册表是它们的唯一凭据来源。catalog 匹配以「本机确实存在该技能」为闸，否则上游近千条可安装目录会污染索引。结果依赖解析机器（与技能作用域同类局限）：换机器注册表不同，出处列会变。 |
| 技能分类 | Skill Category | 用户**手动维护**的技能分组，表达"这个技能是干什么用的"（如 dataworks / 日常工具）。与作用域（扫盘反推、客观）相对，分类是主观的、由用户定义。分类是**一棵树**（`parentId`，null=顶级，如 dataworks → 官方/非官方）；一个技能只挂在一个节点上。每个分类有稳定 id、可改的 label、6 色 neon 之一、同级排序序号。 |
| 分类映射 | Category Assignment | `技能名 → 分类 id` 的**全局映射**，不绑定具体日志。故切换日志时同名技能自动套用同一套分组。存于 `server/skill-categories.json`（个人本地状态）。 |
| 未分类收件箱 | Uncategorized Inbox | "按分类"分组下容纳所有尚未归类技能的组。任何新日志里出现的新技能都会落进这里并高亮，便于用户一眼发现并快速归类处理。 |
| 用户真实输入 | User Utterance | user 消息中剔除所有系统注入与缓存断点标记后的剩余文本（例如"你好"）。 |
| 缓存断点 | Cache Control Breakpoint | 消息内 `<!-- cache_control breakpoint -->` 注释标记，指示 prompt 缓存的边界位置。 |
| 注入放大比 | Injection Ratio | 派生指标：全部系统注入内容的字符数 ÷ 用户真实输入的字符数，用于直观呈现"一句你好背后塞了多少上下文"。 |
| 用量 | Usage | response 中服务端返回的真实 token 统计：prompt / cached / completion / reasoning tokens 与 credits。 |
| 上下文窗口容量 | Context Window | 请求 params 中的 `context_length`——该次请求的真上限。注意 `model-config` 的 `max_input_tokens` 不是窗口容量。 |
| 校准 token 估算 | Calibrated Token Estimate | 本地启发式估算：CJK 码位 ×0.6 + 其余字符 ÷4。仅用于段间比例分配；有 Usage 锚时整体归一化到 `prompt_tokens` 真值。 |
| 上下文面板 | Context Panel | Viewer 中复刻 qodercli `/context` 面板的派生视图：四分类占用（System prompt / System tools / Skills / Messages）+ 窗口占比 + per-skill 份额明细，数值为 wire 真值口径。Autocompact 在 wire 中无对应字段，恒显示 N/A。 |
| 技能文件页 | Skill File Page | Viewer 的独立页面，展示某个技能磁盘目录下的全部文件（SKILL.md 及附属脚本/参考文档）的内容；从上下文面板 Skills 明细的技能名或 📄 新标签页打开，整页高度便于长时间阅读单个技能。 |
| 上下文占用统计 | ContextStats | Parsed Log 中上下文面板对应的结构化产物：窗口容量、已用总量与归一化锚（usage / estimate）、四分类、注入技能份额、技能列表注入实例数。 |
| 解析文档 | Parsed Log | 后端把一份 Wire 日志解析后产出的结构化 JSON（段树 + 每段统计 + 派生指标），是前端的唯一数据源。 |
| 主对话请求 | Main Conversation Request | 承载用户与 agent 真实对话轮次的模型调用。Viewer 日志列表默认只展示这类请求。 |
| 辅助请求 | Auxiliary Call | agent 在**同一会话内**自行发起的小工具调用（如会话标题生成、下一步输入建议），不属于对话本身。注意：它与主对话共享同一会话标识，"不是主会话"的说法不准确——是同一会话内的非对话调用。 |
| 脱敏项 | Redacted Entry | headers / meta 中值被替换为 `[REDACTED]` 的字段，UI 需以特殊样式呈现。 |
