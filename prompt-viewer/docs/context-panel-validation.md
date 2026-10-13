# Context Panel 对账记录（Validation Case）

Viewer「上下文占用」面板（Context Panel，见 CONTEXT.md）与 qodercli `/context` 面板的一次逐数字对账。
结论：**总量精确一致（服务端真值）；分类为 ±0.2pp 的本地近似，误差互相抵消；Skills 明细口径不同（列出 vs 注入），面板已注明。**

## 样本

- Wire 日志：`request-logger/logs/2026-09-14T09-00-59-887_qoder.md`（主对话请求，用户输入仅"你好"）
- 模型：Qwen3.8-Max；`params.context_length = 1,000,000`
- 服务端真值：`usage.prompt_tokens = 24,783`，completion 87，credits 2.6776
- `/context` 面板：2.5% used；System prompt 0.3% / System tools 1.2% / Skills 0.5% / Messages 0.5% / Free 90.6% / Autocompact 6.9%；Session stats: Messages 6, Prompts 1

## 1. 总量锚：精确一致

`/context` 的 2.5% 就是服务端真值：24,783 ÷ 1,000,000 = 2.478% → 面板一位小数显示 2.5%。
Viewer 面板直接取 `usage.prompt_tokens`（anchor = usage），显示 2.48%（两位小数）。
**总量不是估算，两边同源。**

## 2. 四分类对比：±0.2pp 本地近似，误差互抵

`/context` 自己标注 "Estimated usage by category (local approximation)"。Viewer 用校准估算（见 §7）再归一化到 24,783：

| 类别 | /context | wire 估算 tok | 归一化 tok | wire % | 偏差 |
|---|---|---|---|---|---|
| System prompt | 0.3% | 4,225 | 4,308 | 0.43% | +0.13pp |
| System tools | 1.2% | 13,814 | 14,087 | 1.41% | +0.21pp |
| Skills | 0.5% | 3,579 | 3,650 | 0.37% | −0.13pp |
| Messages | 0.5% | 2,685 | 2,738 | 0.27% | −0.23pp |
| **合计** | **2.5%** | **24,303** | **24,783** | **2.48%** | ✓ |

观察：

- 两边**合计完全一致**（都锚定同一真值），单项偏差 ≤0.23pp 且方向互抵（prompt+tools 偏低、skills+messages 偏高）。
- wire 侧分类边界：System prompt ← `<system-prompt>`；System tools ← `<tools>`；Skills ← 全部技能列表注入实例；Messages ← 其余一切（agent-types 注入、agentsMd 注入、用户输入、历史 assistant 消息）。
- Messages 偏差最大（0.5% vs 0.27%），推测 `/context` 把部分会话元数据也计入 Messages；wire 侧只统计实际进请求的内容。

## 3. per-skill 份额语义：Skills 类别内占比，不是窗口占比

`/context` Skills 页的百分比（Project 17 项 + User 41 项 + Built-in 15 项）合计 99.9%——是 **Skills 类别内的份额**，不是占 1M 窗口的比例。例：a1 = 10% ≈ 500 tok（按面板 Skills ≈5k tok 折算）。

Viewer 面板同语义但分母不同：份额 = 单技能估算 ÷ **注入列表**估算合计。实测 a1 = 9%（324 tok / 3,619 tok），46 项份额合计 100.0%。

两边 a1 都居榜首且量级一致；绝对值差异来自 §4 的分母口径 + `/context` 自身的近似。

## 4. 核心发现：列出 73 ≠ 注入 46，差值全部是 `disable-model-invocation: true`

`/context` Skills 页列出 73 个技能；wire 技能列表注入只有 46 个。差集 27 个：

```
ask-matt, batch, claude-handoff, debug, export-session, grill-me,
grill-with-docs, handoff, implement, implement-spec,
improve-codebase-architecture, loop-me, quest, recon-builder,
run-skill-generator, setup-matt-pocock-skills, single-html-recon-report,
teach, to-questionnaire, to-spec, to-tickets, triage, wait-what,
wayfinder, writing-beats, writing-fragments, writing-shape
```

逐一核查 SKILL.md frontmatter：**27 个全部声明 `disable-model-invocation: true`**（只能由用户手动 `/调用`，模型不可主动触发）。反向验证在 mattpocock 插件市场（`~/.qoder/plugins/marketplaces/mattpocock/`）成立：19 个带 flag 的技能全部缺席注入列表，不带 flag 的全部在场——**双向完美相关**。

含义：

- 这 27 个列出技能**零 token 成本**，不进 wire；`/context` Skills 页的份额分母包含它们，是系统性偏差（本例中 27/73 ≈ 23.1% 的份额条目是零成本的）。
- Viewer 面板只列注入技能（wire 真值口径），并在 banner 注明该口径差异。
- wire 无 Project/User/Built-in 作用域信息，面板 Skills 明细的作用域分组为解析期扫盘反推（见 §8）。
- 附带发现：User 作用域包含 `~/.agents/skills/`（export-session 实际位于此，而非 `~/.qoder/skills/` 或 `~/.claude/skills/`）。
- 本样本注入的 46 个技能全部带描述，占位技能（Placeholder Skill）数为 0。

## 5. 窗口容量判定：`context_length` 是真上限

- `params.context_length = 1,000,000` —— 与 `/context` 头部 "1M context" 一致，**这是真上限**（用户确认的权威口径）。
- `model-config.max_input_tokens = 180,000` —— **不是**窗口容量，面板不使用。
- Free space = context_length − prompt_tokens = 975,217（97.52%）。`/context` 显示 Free 90.6%，因为它额外扣掉了 Autocompact 预留（见 §6）。

## 6. Autocompact：open question，面板显示 N/A

`/context` 显示 Autocompact 6.9%（≈69k tok，自动压缩前的预留缓冲区）。**wire 请求中没有任何对应字段**，无法从日志验证其存在与大小。Viewer 面板恒显示 N/A（悬停可见本说明），Free space 按不扣减 Autocompact 计算——这也是面板 Free（97.5%）与 `/context` Free（90.6%）差异的全部来源。

## 7. 校准估算器

`estimateTokens(text) = CJK 码位数 × 0.6 + 其余字符数 ÷ 4`（CJK 含部首扩展、中日标点、假名、兼容表意、全角形式区段）。

本样本全量实测：估 24,303 vs 真值 24,783，**低估 1.9%**。仅用于段间比例分配；有 usage 时整体乘以归一化系数（本例 24,783/24,303 ≈ 1.0198）锚回真值，无 usage 时退化为纯估算（anchor = estimate，面板以琥珀色徽章提示）。

## 8. 技能作用域反推（Project / User / Built-in 分组）

wire 注入列表**不携带作用域字段**（meta、headers、params、other-fields 均无 cwd/scope；request-logger 是 MITM 代理，也拿不到 qodercli 的工作目录）。`/context` 的三组来自 qodercli 扫盘时按发现路径归类；Viewer 在解析期按同规则 best-effort 反推（`server/src/skillScopes.ts`）：

1. **Project** —— `<发起目录>/.qoder/skills`。发起目录配置在 `server/skill-roots.json`（本样本 = `/Users/yuanjingtao/Documents/ai-workspace2/dataworks-workspace`，经磁盘考古确认：`/context` Project 组的 recon-builder、data-science/ 嵌套技能等只在该目录下存在）。优先级最高。
2. **User** —— 用户级目录：`~/.qoder/skills`、`~/.claude/skills`、`~/.agents/skills`、`~/.hermes/skills`、`~/.qoder/plugins/marketplaces`。
3. **Built-in** —— 残余：以上都查不到的名字归为内置（磁盘无对应目录）。

同名技能按 project > user 取先命中者（与 `/context` 一致）。索引 30s TTL 缓存；扫盘不可用时全部标 `unknown`（面板单列"未知"组）。

**符号链接陷阱**：项目 `.qoder/skills` 下大量条目是指向 `~/.hermes/skills/*` 的符号链接（如 `alfa -> ~/.hermes/skills/alfa`）。首版用 `Dirent.isDirectory()` 判目录，对符号链接恒为 false，导致这些技能在项目扫描中被跳过、落到用户扫描里误判为 user（实测 project 只认出 1 个）。修复：递归时对符号链接做 `statSync().isDirectory()` 跟随，环路靠 MAX_DEPTH=5 兜底；SKILL.md 判定同样跟随符号链接。

**本样本对账**（46 个注入技能）：

| 组 | Viewer 反推 | /context 列出组扣除未注入后的期望 | 差异 |
|---|---|---|---|
| Project | 14 | 14（列出 17，其中 recon-builder、single-html-recon-report、grill-with-docs 未注入） | 0 |
| User | 20 | 21 | −1 |
| Built-in | 12 | 11 | +1 |

唯一错位是 `create-command`：`/context` 归 User，但它实际位于 `~/.qoder/commands/create-command.md`（command 形态，不在任何 `skills/` 目录下），残余启发式把它归到了 Built-in。属已知的 best-effort 局限，不影响份额数值。
