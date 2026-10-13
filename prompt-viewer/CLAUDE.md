# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Prompt Viewer 把 `../request-logger/logs/*.md`（wire 日志）渲染成深色 IDE 风的可视化页面。
wire 日志的**生产方**是父仓库的 `request-logger/render.ts`（每种 agent wire format 一个 renderer）；
本项目的 `server/src/parser.ts` 是它的**消费方**。改解析逻辑前先看 render.ts 里对应 renderer 的输出形状，两边必须对齐。

## Commands

```bash
npm run dev      # 一条命令拉起前后端（concurrently）：Hono :3001 + Vite :8517
npm run build    # 构建 web/dist
npm run start    # build 后由 Hono 单进程托管（API + 静态）
npx tsc --noEmit -p server   # 后端类型检查
npx tsc --noEmit -p web      # 前端类型检查
```

无测试框架；验证方式是 `npm run dev` 后用浏览器看 `/api/logs/:id` 的 JSON 与页面渲染。
Vite 端口刻意设为 **8517 + strictPort**（5173/5174 常被占用），被占用时应报错而非漂移。
Vite dev 将 `/api` 代理到 `:3001`。

## Architecture

npm workspaces 两包：`server/`（Hono + TS，解析）与 `web/`（Vite + React 19 + Tailwind CSS 4，渲染）。
**解析全部在后端**：前端只消费 Parsed Log JSON（契约见 `server/src/types.ts`，`web/src/types.ts` 手工保持同构，改一处必须同步另一处）。

### 解析器不变量（server/src/parser.ts）

1. **白名单 + 整行锚定**：只有 Wire 标签（`meta/headers/request/params/model-config/system-prompt/tools/messages/message/other-fields/response/thinking/assistant-text`）参与结构解析，且必须匹配 `^<tag>$` / `^</tag>$`。system-prompt/tools **内容里**出现的示例标签（Echo Tag，如 `<EXTREMELY-IMPORTANT>`、`<system-reminder>` 的行内提及）绝不能当结构——这是本解析器最容易踩的坑。
2. **语法感知**：子段只在父段内容范围内查找（request → params/tools/messages…；response → thinking/assistant-text）。
3. **容忍缺段**：小请求没有 `tools`/`thinking`/reminder，缺了置 null，不报错；`parseWarnings` 只记录真正的异常。
4. `<message>` 内容按整行 `<system-reminder>` 切分为「系统注入块」+「用户真实输入块」；`<!-- cache_control breakpoint -->` 是缓存断点标记，统计用户输入字符数时要剔除。
5. usage 的 `cached_tokens`/`reasoning_tokens` 嵌套在 `prompt_tokens_details`/`completion_tokens_details` 里，解析时展平到 `Usage`。
6. 技能列表注入块（system-reminder 以 `The following skills are available…` 整行起始）规范化解析为 `SkillEntry[]`：名字按首个「`: `」切分（名字可含冒号，如 `plugin:skill`），非 `- ` 开头的续行并入描述；**纯名字条目（description 为 null）= 禁用技能**，`disabled: true`，`chars` 记录该条目注入原文字符数供前端 token 估算。`derived.skillCount`/`skillDisabledCount` 取多条消息中最大那份列表的统计（同一列表会随对话重复注入）。非技能 reminder 的 `skills` 一律为 null，不影响原有解析。
7. `classifyWireLog` 把每份日志分类为**主对话请求 / 辅助请求**（术语见 CONTEXT.md）。判别级联：主判据是 `<other-fields>` JSON 顶层 `task_id`（`"common"` = 主对话；其余非空值 = 辅助，`auxTask` 取 `business.sub_task`，缺省退回 `business.name`）；取不到时降级看 `<meta>` 的 `**model**`（`lite` = 辅助）；两级都失败 **fail-open 归为主对话**（宁可多显示，不可误藏）。`GET /api/logs` 始终返回全部条目并附 `kind`/`auxTask`，前端侧边栏按开关过滤（默认只显示主对话，开关状态存 localStorage）。
8. **技能手动分类**是 `name → categoryId` 的**全局映射**（存 `server/skill-categories.json`，不绑定具体日志），故切换日志自动套用同一分组。分类本身是**一棵树**（`SkillCategory.parentId`，null=顶级；`normalizeDoc` 会断开自环/环链），技能挂在任一节点；"按分类"分组按树递归嵌套渲染（父组表头显示子树合计），归类下拉用 path 标签（`dataworks / 官方`）。解析期由 `categoryIndex`（第 5 参）给每个 `SkillShareEntry` 挂 `categoryId`（解析那一刻的快照真值）。**关键约定**：前端交互层一律以最新的 `categoriesDoc.assignments[name]` 为准，而非 `s.categoryId`——后者在用户改分类后会变旧，用 live doc 才能即时生效、无需重新解析当前日志。
9. **磁盘兜底描述**：wire 未注入描述（占位技能）且扫盘有目录时，解析期经注入的 `diskDescriptionOf`（第 6 参，由 index.ts 传入 `readSkillDescription`）读技能目录 `SKILL.md` frontmatter 的 `description`，写入 `SkillShareEntry.diskDescription`。parser 本身不碰 fs。frontmatter 支持单行值、`>-`/`|` 块、以及「键行值为空 + 后续缩进行」三种形态；60s TTL 缓存（一次解析上百技能不能每次重读）。builtin（磁盘无目录）恒为 null。前端以弱化斜体 + 💾 标注来源，与 wire 真值区分。

### 领域词汇

`CONTEXT.md` 是词汇表（Wire 标签 / Echo Tag / 系统注入 / 用户真实输入 / 注入放大比 / 解析文档…），
`docs/adr/0001-*.md` 记录了"独立子项目 + Hono/React 分离栈"的取舍。新增术语进 CONTEXT.md，实现细节不进。

### 前端约定

- Tailwind 4 自定义色板在 `web/src/index.css` 的 `@theme`（ink-* 底色、mist-* 文本、neon-* 强调色）；markdown 统一走 `components/Markdown.tsx`（react-markdown + gfm + highlight），**不渲染 HTML**，因此 Echo Tag 天然以纯文本展示。
- 每个 wire 段 = 一张 `SectionCard`（可折叠 + 统计摘要）；system-prompt 的 mini-TOC 靠渲染后 DOM 扫描生成 id（对 StrictMode 双渲染稳定），不要用渲染期计数器。
- 概览仪表盘的核心叙事是「注入放大比」= 系统注入字符 ÷ 用户真实输入字符。
- Skills 明细列宽可拖拽：列宽存 localStorage（`prompt-viewer:skill-col-widths`），经外层容器的 CSS 变量 `--skill-cols` 下发给表头与每行（`gridTemplateColumns: var(--skill-cols)`）。**拖拽只改这一个变量**，`SkillRow` 是 `memo` 且 `onAssign` 用 `useCallback` 稳定引用，故 174 行不随拖拽重渲染——改列宽机制时别把 grid 模板改成逐行 prop，会卡。列模型见 `ContextPanel.tsx` 的 `COLS`：描述/位置是 `minmax(宽,1fr)` 弹性列，吸收宽屏剩余宽度（拖拽为它们设最小宽）；其余列（含比例条）为固定 px、拖拽精确生效。`<main>` 不设 max-width，宽屏不留右侧空白。

## Data source

日志目录解析自 `import.meta.dirname` 相对路径 `../../../request-logger/logs`（server/src/index.ts），
**只读**；`GET /api/logs/:id` 对 id 做了字符集白名单防路径穿越。解析失败降级返回 `{parseError, raw}`，前端以纯文本展示。

后端唯一的**写路径**是技能分类档 `server/skill-categories.json`（gitignore 的个人本地状态，与 `skill-roots.json` 同目录）：
`GET /api/skill-categories` 读整档，`PUT /api/skill-categories` 整档覆盖写回（先形状校验→`normalizeDoc` 收敛→`.tmp`+rename 原子写→置 `categoryCache=null` 立即失效）。
读写与校验在 `server/src/skillCategories.ts`；30s TTL 缓存仿 `scopeCache`。文件缺失/损坏一律降级为空档，绝不抛错中断解析。
