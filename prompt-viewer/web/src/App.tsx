import { useEffect, useMemo, useState } from "react";
import { DEFAULT_LOG_ID, fetchLog, fetchLogs, fetchSkillCategories, saveSkillCategories } from "./api";
import type { LogListItem, ParsedLog, SkillCategoriesDoc } from "./types";
import { fmtStats } from "./format";
import { Sidebar, type TocEntry } from "./components/Sidebar";
import { Overview } from "./components/Overview";
import { ContextPanel } from "./components/ContextPanel";
import { Badge, SectionCard } from "./components/SectionCard";
import { HeadersTable } from "./components/HeadersSection";
import { KVGrid } from "./components/KVGrid";
import { SystemPromptSection } from "./components/SystemPromptSection";
import { ToolsSection } from "./components/ToolsSection";
import { MessagesSection } from "./components/MessagesSection";
import { OtherFieldsSection } from "./components/OtherFieldsSection";
import { ResponseSection } from "./components/ResponseSection";

/** 「显示辅助请求」开关的持久化键（默认关：列表只展示主对话请求） */
const SHOW_AUX_KEY = "prompt-viewer:show-aux";

function readShowAux(): boolean {
  try {
    return localStorage.getItem(SHOW_AUX_KEY) === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const [logs, setLogs] = useState<LogListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>(DEFAULT_LOG_ID);
  const [log, setLog] = useState<ParsedLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<{ parseError: string; raw?: string } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [showAux, setShowAux] = useState<boolean>(readShowAux);
  // 技能分类档：app 级、与选中日志无关（name→categoryId 全局映射）
  const [categoriesDoc, setCategoriesDoc] = useState<SkillCategoriesDoc>({ categories: [], assignments: {} });

  useEffect(() => {
    try {
      localStorage.setItem(SHOW_AUX_KEY, showAux ? "1" : "0");
    } catch {
      // 隐私模式等场景下 localStorage 不可用，放弃持久化即可
    }
  }, [showAux]);

  useEffect(() => {
    // 分类档拉取失败不阻断浏览：退化为空档，所有技能落「未分类」
    fetchSkillCategories()
      .then(setCategoriesDoc)
      .catch((e) => console.error("[prompt-viewer] 载入技能分类失败:", e));
  }, []);

  // 整档写回；失败时抛出，由调用方（ContextPanel）就地提示
  const handleSaveCategories = async (next: SkillCategoriesDoc): Promise<void> => {
    const saved = await saveSkillCategories(next);
    setCategoriesDoc(saved);
  };

  useEffect(() => {
    fetchLogs()
      .then((items) => {
        setLogs(items);
        // 默认日志不存在时回退到最新一份主对话（列表默认只展示主对话，
        // 不该一进来就选中一条被隐藏的辅助请求）
        if (items.length > 0 && !items.some((i) => i.id === DEFAULT_LOG_ID)) {
          const fallback = items.find((i) => i.kind === "main") ?? items[0];
          setSelectedId(fallback.id);
        }
      })
      .catch((e) => setListError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setLoading(true);
    setFatal(null);
    fetchLog(selectedId)
      .then((res) => {
        if (res.ok && res.log) setLog(res.log);
        else {
          setLog(null);
          setFatal({ parseError: res.parseError ?? "解析失败", raw: res.raw });
        }
      })
      .catch((e) => {
        setLog(null);
        setFatal({ parseError: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => setLoading(false));
  }, [selectedId]);

  const toc = useMemo<TocEntry[]>(() => {
    if (!log) return [];
    const t: TocEntry[] = [{ id: "overview", label: "概览仪表盘", icon: "◎" }];
    t.push({ id: "sec-context", label: "上下文占用", icon: "📊" });
    if (log.headers.length) t.push({ id: "sec-headers", label: "HTTP Headers", icon: "📨" });
    if (log.request.params.length || log.request.modelConfig.length)
      t.push({ id: "sec-model", label: "模型配置", icon: "🧠" });
    if (log.request.systemPrompt) t.push({ id: "sec-system-prompt", label: "System Prompt", icon: "📜" });
    if (log.request.tools) t.push({ id: "sec-tools", label: `工具定义 (${log.derived.toolCount})`, icon: "🛠" });
    if (log.request.messages.length) t.push({ id: "sec-messages", label: "消息流", icon: "💬" });
    if (log.request.otherFields) t.push({ id: "sec-other-fields", label: "Other Fields", icon: "🧩" });
    if (log.response) t.push({ id: "sec-response", label: "模型响应", icon: "⚡" });
    return t;
  }, [log]);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        logs={logs}
        selectedId={selectedId}
        onSelect={setSelectedId}
        toc={toc}
        log={log}
        showAux={showAux}
        onToggleShowAux={() => setShowAux((v) => !v)}
      />

      <main className="flex-1 min-w-0 px-5 py-5 lg:px-8">
        {listError && (
          <div className="rounded-lg border border-neon-red/40 bg-neon-red/5 p-4 text-sm text-neon-red mb-4">
            无法连接后端：{listError}（请确认 <code>npm run dev</code> 已同时拉起 server）
          </div>
        )}

        {loading && (
          <div className="flex h-64 items-center justify-center text-mist-500 font-mono text-sm">
            <span className="animate-pulse">⚡ 解析 wire 日志中…</span>
          </div>
        )}

        {!loading && fatal && (
          <div className="space-y-3">
            <div className="rounded-lg border border-neon-red/40 bg-neon-red/5 p-4 text-sm text-neon-red">
              解析失败（已降级为原始文本）：{fatal.parseError}
            </div>
            {fatal.raw && (
              <pre className="rounded-lg border border-ink-700 bg-ink-950 p-4 text-[12px] font-mono text-mist-300 overflow-auto max-h-[70vh] whitespace-pre-wrap">
                {fatal.raw}
              </pre>
            )}
          </div>
        )}

        {!loading && log && (
          <div className="space-y-4 pb-16">
            <Overview log={log} />

            <ContextPanel log={log} categoriesDoc={categoriesDoc} onSaveCategories={handleSaveCategories} />

            {log.parseWarnings.length > 0 && (
              <div className="rounded-lg border border-neon-amber/30 bg-neon-amber/5 px-3.5 py-2 text-[12px] text-neon-amber">
                ⚠️ {log.parseWarnings.join("；")}
              </div>
            )}

            {log.headers.length > 0 && (
              <SectionCard
                id="sec-headers"
                tag="<headers>"
                title="HTTP 请求头"
                icon="📨"
                accent="blue"
                badges={[
                  <Badge key="n" accent="blue">{log.headers.length} 个字段</Badge>,
                  <Badge key="r" accent="red">
                    🔒 {log.headers.filter((h) => h.redacted).length} 项脱敏
                  </Badge>,
                ]}
                copyText={log.headers.map((h) => `${h.key}: ${h.value}`).join("\n")}
              >
                <HeadersTable entries={log.headers} />
              </SectionCard>
            )}

            {(log.request.params.length > 0 || log.request.modelConfig.length > 0) && (
              <SectionCard
                id="sec-model"
                tag="<params> + <model-config>"
                title="模型配置"
                icon="🧠"
                accent="purple"
                badges={[
                  ...(log.request.modelConfig.find((m) => m.key === "display_name")?.value
                    ? [<Badge key="m" accent="purple">{log.request.modelConfig.find((m) => m.key === "display_name")!.value}</Badge>]
                    : []),
                  ...(log.request.modelConfig.find((m) => m.key === "is_reasoning")?.value === "true"
                    ? [<Badge key="r" accent="cyan">reasoning</Badge>]
                    : []),
                  ...(log.request.modelConfig.find((m) => m.key === "is_vl")?.value === "true"
                    ? [<Badge key="v" accent="green">多模态 VL</Badge>]
                    : []),
                ]}
              >
                <div className="space-y-4">
                  {log.request.params.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[11px] font-semibold text-mist-500 font-mono">params</div>
                      <KVGrid items={log.request.params} />
                    </div>
                  )}
                  {log.request.modelConfig.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[11px] font-semibold text-mist-500 font-mono">model-config</div>
                      <KVGrid items={log.request.modelConfig} />
                    </div>
                  )}
                </div>
              </SectionCard>
            )}

            {log.request.systemPrompt && (
              <SectionCard
                id="sec-system-prompt"
                tag="<system-prompt>"
                title="系统提示词"
                icon="📜"
                accent="cyan"
                badges={[<Badge key="b" accent="cyan">Agent 人格与规则</Badge>]}
                statsText={fmtStats(log.request.systemPrompt.stats.lines, log.request.systemPrompt.stats.chars)}
                copyText={log.request.systemPrompt.data}
              >
                <SystemPromptSection markdown={log.request.systemPrompt.data} />
              </SectionCard>
            )}

            {log.request.tools && (
              <SectionCard
                id="sec-tools"
                tag="<tools>"
                title="工具定义"
                icon="🛠"
                accent="cyan"
                badges={[<Badge key="n" accent="cyan">{log.derived.toolCount} 个工具</Badge>]}
                statsText={fmtStats(log.request.tools.stats.lines, log.request.tools.stats.chars)}
              >
                <ToolsSection entries={log.request.tools.entries} />
              </SectionCard>
            )}

            {log.request.messages.length > 0 && (
              <SectionCard
                id="sec-messages"
                tag="<messages>"
                title="消息流"
                icon="💬"
                accent="green"
                defaultOpen
                badges={[
                  <Badge key="m" accent="green">{log.request.messages.length} 条消息</Badge>,
                  <Badge key="r" accent="amber">📌 {log.derived.reminderCount} 处系统注入</Badge>,
                ]}
                statsText={
                  log.request.messagesStats
                    ? fmtStats(log.request.messagesStats.lines, log.request.messagesStats.chars)
                    : undefined
                }
                banner={
                  <div className="rounded-lg border border-neon-amber/25 bg-neon-amber/[0.04] px-3.5 py-2 text-[12px] text-mist-300">
                    👀 注意：这条 user 消息里{" "}
                    <b className="text-neon-amber">绝大部分内容不是用户打的</b> ——
                    琥珀色块是运行时注入的系统上下文，绿色气泡才是用户真实输入。
                  </div>
                }
              >
                <MessagesSection messages={log.request.messages} />
              </SectionCard>
            )}

            {log.request.otherFields && (
              <SectionCard
                id="sec-other-fields"
                tag="<other-fields>"
                title="其他请求字段"
                icon="🧩"
                accent="amber"
                badges={
                  log.request.otherFields.duplicateInjection
                    ? [<Badge key="d" accent="amber">⚠️ 存在重复注入</Badge>]
                    : []
                }
                copyText={log.request.otherFields.raw}
              >
                <OtherFieldsSection data={log.request.otherFields} />
              </SectionCard>
            )}

            {log.response && (
              <SectionCard
                id="sec-response"
                tag="<response>"
                title="模型响应"
                icon="⚡"
                accent="green"
                defaultOpen
                badges={[
                  ...(log.response.finishReason
                    ? [<Badge key="f" accent="green">{log.response.finishReason}</Badge>]
                    : []),
                  ...(log.response.usage?.total_tokens
                    ? [<Badge key="t" accent="blue">{log.response.usage.total_tokens.toLocaleString()} tokens</Badge>]
                    : []),
                ]}
                statsText={fmtStats(log.response.stats.lines, log.response.stats.chars)}
              >
                <ResponseSection log={log} />
              </SectionCard>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
