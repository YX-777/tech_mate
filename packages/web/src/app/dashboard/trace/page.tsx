"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Input, Button, Tag, Empty, Typography, Tooltip, Space, Collapse, Skeleton } from "antd";
import { SearchOutlined, ReloadOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { useSearchParams } from "next/navigation";
import Navbar from "@/components/shared/Navbar";
import BottomNav from "@/components/shared/BottomNav";

const { Title, Text } = Typography;

const DEFAULT_USER_ID = "default-user";

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  status: "pending" | "success" | "error";
  attributes: Record<string, any>;
}

interface Trace {
  traceId: string;
  startTime: number;
  endTime: number;
  totalMs: number | null;
  spanCount: number;
  conversationId: string;
  userId: string;
  spans: Span[];
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  hasTrace?: boolean;
}

/**
 * Span 字典 —— 把内部 span 名转成中文标签 + 大白话解释。
 * 每个 span 对应 Agent 链路的一个步骤，trace 文件 grep 一下就能复盘。
 */
const SPAN_META: Record<string, { label: string; explain: string; color: string; category: string }> = {
  "api_request": { label: "🚪 请求入口", explain: "整个 HTTP 请求生命周期", color: "#6b7280", category: "infra" },
  "db_init": { label: "🗄️ 数据库初始化", explain: "Prisma + ChromaDB 客户端就绪", color: "#a3a3a3", category: "infra" },
  "conversation_query": { label: "💬 会话校验", explain: "查 conversation 是否存在 + 归属当前用户", color: "#a3a3a3", category: "infra" },
  "agent_process": { label: "🧠 Agent 处理", explain: "LangGraph StateGraph 整体执行（包含所有 node/tool）", color: "#6366f1", category: "agent" },
  "message_storage": { label: "💾 消息持久化", explain: "把 user message + assistant response + 执行步骤写入 SQLite", color: "#a3a3a3", category: "infra" },
  "guardrail.input": { label: "🛡️ 输入侧防护（L1 注入 / SSRF 短路）", explain: "注入规则扫一遍用户消息；命中内网/SSRF 探测地址则在进 pipeline 前直接短路拦截（status=error 即本次被输入侧拦下）", color: "#16a34a", category: "guardrail" },
  "guardrail.tool": { label: "🛡️ L2 工具参数校验", explain: "Zod schema + SQL/Shell/SSRF 黑名单，调工具前先 check", color: "#0891b2", category: "guardrail" },
  "guardrail.output": { label: "🛡️ L3 输出相关性+幻觉", explain: "Jaccard 算问答相关性，启发式抽事实陈述 vs RAG corpus 字符串覆盖", color: "#7c3aed", category: "guardrail" },
  "memory.fusion": { label: "🧠 四阶记忆融合", explain: "瞬时/短期/长期/元 四路并行检索后按权重拼接上下文；attrs 带各层条数 + parallelMs", color: "#0d9488", category: "memory" },
  "memory.instant": { label: "⚡ 瞬时记忆", explain: "滑动窗口裁剪最近 N 条消息 + token 预算（内存操作，≈0ms）", color: "#14b8a6", category: "memory" },
  "memory.short": { label: "🕒 短期记忆", explain: "SQLite 查近期话题，按艾宾浩斯式新鲜度排序（半衰期 7 天）", color: "#14b8a6", category: "memory" },
  "memory.long": { label: "📦 长期记忆", explain: "ChromaDB 向量相似检索 + 权重×相似度加权（四路里通常是延迟瓶颈）", color: "#14b8a6", category: "memory" },
  "memory.meta": { label: "🧬 元记忆", explain: "聚合用户画像/技能图谱/强弱项（SQLite），注入 prompt 做个性化", color: "#14b8a6", category: "memory" },
  "memory.review": { label: "🔁 复习推荐", explain: "按艾宾浩斯遗忘曲线（与记忆衰减同一函数）算各模块预测保持度，accuracy 调制半衰期，低于阈值建议复习", color: "#14b8a6", category: "memory" },
  "tool.rag_retrieve": { label: "📚 RAG 检索", explain: "LlamaIndex HybridFusion（Vector+BM25）→ RRF → BGE-M3 重排 → 三级策略", color: "#0ea5e9", category: "tool" },
  "tool.web_search": { label: "🌐 联网搜索", explain: "Tavily Search API，5s 超时降级，仅在时效问题 / RAG fallback 时触发", color: "#f59e0b", category: "tool" },
  "llm.stream": { label: "💬 LLM 流式输出", explain: "DashScope qwen3.6-plus，stream=true 逐 chunk 返回；记 firstByteMs + chunkCount", color: "#8b5cf6", category: "llm" },
};

function spanMeta(name: string): { label: string; explain: string; color: string; category: string } {
  if (SPAN_META[name]) return SPAN_META[name];
  if (name.startsWith("guardrail.")) return { label: name, explain: "GuardRail 检查", color: "#16a34a", category: "guardrail" };
  if (name.startsWith("tool.")) return { label: name, explain: "工具调用", color: "#f59e0b", category: "tool" };
  if (name.startsWith("llm.")) return { label: name, explain: "LLM 调用", color: "#8b5cf6", category: "llm" };
  return { label: name, explain: "未分类 span", color: "#6b7280", category: "infra" };
}

/** 慢 span 阈值 */
const SLOW_MS_BY_CATEGORY: Record<string, number> = {
  guardrail: 50,
  tool: 1500,
  llm: 3000,
  infra: 200,
  agent: 5000,
  memory: 1200,
};

/**
 * 自动诊断：给出"这个 trace 有什么值得关注的点"
 */
function diagnose(trace: Trace): { type: "info" | "warning" | "success"; text: string }[] {
  const items: { type: "info" | "warning" | "success"; text: string }[] = [];
  const totalMs = trace.totalMs || 0;

  // 1) 总耗时评级
  if (totalMs < 3000) items.push({ type: "success", text: `🚀 总耗时 ${totalMs}ms（健康范围 <3s）` });
  else if (totalMs < 8000) items.push({ type: "info", text: `⏱️ 总耗时 ${totalMs}ms（可接受，建议关注下方耗时大户）` });
  else items.push({ type: "warning", text: `🐢 总耗时 ${totalMs}ms（偏慢，请检查 LLM/RAG 是否阻塞）` });

  // 2) 首字节
  const llmSpan = trace.spans.find(s => s.name === "llm.stream");
  if (llmSpan) {
    const firstByte = llmSpan.attributes?.firstByteMs;
    if (typeof firstByte === "number") {
      if (firstByte < 1500) items.push({ type: "success", text: `⚡ LLM 首字节 ${firstByte}ms（流式体验流畅）` });
      else if (firstByte < 3000) items.push({ type: "info", text: `LLM 首字节 ${firstByte}ms（可优化 prompt 长度）` });
      else items.push({ type: "warning", text: `LLM 首字节 ${firstByte}ms（建议精简 system prompt 或缓存检索结果）` });
    }
  }

  // 3) GuardRail 命中
  const grHits = trace.spans
    .filter(s => s.name.startsWith("guardrail."))
    .reduce((acc, s) => acc + (Number(s.attributes?.hits) || 0), 0);
  if (grHits === 0) {
    items.push({ type: "success", text: `🛡️ GuardRail 三层全部通过（0 命中）` });
  } else {
    items.push({ type: "warning", text: `🛡️ GuardRail 命中 ${grHits} 项（点击对应 span 看详情）` });
  }

  // 4) 慢 span
  const slow = trace.spans.filter(s => {
    const meta = spanMeta(s.name);
    const thresh = SLOW_MS_BY_CATEGORY[meta.category] ?? 1000;
    return (s.durationMs ?? 0) > thresh;
  });
  if (slow.length > 0) {
    const top = slow.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0];
    items.push({
      type: "warning",
      text: `🐢 耗时大户：${spanMeta(top.name).label} ${top.durationMs}ms（超出该类型预期）`,
    });
  }

  // 5) 错误 span
  const errors = trace.spans.filter(s => s.status === "error");
  if (errors.length > 0) {
    items.push({ type: "warning", text: `❌ ${errors.length} 个 span 失败：${errors.map(e => spanMeta(e.name).label).join("、")}` });
  }

  // 6) RAG tier 信息
  const ragSpan = trace.spans.find(s => s.name === "tool.rag_retrieve");
  if (ragSpan?.attributes?.preferHybrid) {
    items.push({ type: "info", text: `📚 RAG 用 LlamaIndex HybridFusion + BGE-M3 重排` });
  }

  return items;
}

export default function TraceViewerPage() {
  const searchParams = useSearchParams();
  const urlConversationId = searchParams.get("conversationId") || "";
  const urlTraceId = searchParams.get("traceId") || "";

  const [conversationId, setConversationId] = useState(urlConversationId);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const highlightTraceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`/api/conversations?userId=${DEFAULT_USER_ID}&limit=50`).then(r => r.json()).catch(() => ({ conversations: [] })),
      fetch("/api/observability/trace?list=1").then(r => r.json()).catch(() => ({ conversations: [] })),
    ]).then(([convResp, traceResp]) => {
      const traced = new Set<string>(traceResp.conversations || []);
      const list: ConversationSummary[] = (convResp.conversations || []).map((c: any) => ({
        id: c.id,
        title: c.title || "(未命名)",
        updatedAt: c.updatedAt,
        hasTrace: traced.has(c.id),
      }));
      list.sort((a, b) => {
        if (a.hasTrace !== b.hasTrace) return a.hasTrace ? -1 : 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
      setConversations(list);
    }).finally(() => setInitialLoading(false));
  }, []);

  // URL 参数自动加载（chat 卡片跳来时直接展示对应 trace）
  useEffect(() => {
    if (urlConversationId) {
      loadTrace(urlConversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlConversationId]);

  // 加载完成后滚动到高亮 trace
  useEffect(() => {
    if (urlTraceId && traces.length > 0 && highlightTraceRef.current) {
      highlightTraceRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [urlTraceId, traces]);

  async function loadTrace(cid?: string) {
    const id = cid ?? conversationId;
    if (!id.trim()) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/observability/trace?conversationId=${encodeURIComponent(id.trim())}`);
      const d = await r.json();
      setTraces(d.traces || []);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#fafafa" }}>
      <Navbar />
      <div style={{ padding: "20px", maxWidth: 1200, margin: "0 auto" }}>
        <Title level={3} style={{ marginBottom: 6 }}>
          🔍 Trace Viewer
        </Title>
        <Text type="secondary">
          按 conversationId 回溯一次对话的完整调用链 —— 节点跳转 / 工具调用 / LLM stream / GuardRail 检查，全部接 OpenTelemetry。
        </Text>

        {/* ============ 概念说明 ============ */}
        <Card style={{ marginTop: 12, borderRadius: 10, background: "#fafaff", border: "1px solid #ede9fe" }} bordered={false}>
          <Collapse
            ghost
            items={[
              {
                key: "explain",
                label: (
                  <Text strong style={{ fontSize: 13, color: "#7c3aed" }}>
                    <InfoCircleOutlined /> 调用链上的每一步代表什么？（点击展开）
                  </Text>
                ),
                children: (
                  <div style={{ fontSize: 12, color: "#4b5563", display: "flex", flexDirection: "column", gap: 6 }}>
                    {Object.entries(SPAN_META).map(([name, meta]) => (
                      <div key={name} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <span style={{ width: 18, height: 18, borderRadius: 3, background: meta.color, opacity: 0.85, flexShrink: 0 }} />
                        <code style={{ fontFamily: "monospace", color: "#7c3aed", minWidth: 160, fontSize: 11 }}>{name}</code>
                        <span style={{ minWidth: 110, fontWeight: 500 }}>{meta.label}</span>
                        <span style={{ flex: 1, opacity: 0.85 }}>{meta.explain}</span>
                      </div>
                    ))}
                    <div style={{ marginTop: 6, padding: 8, background: "#fff", borderRadius: 4, fontSize: 11, color: "#6b7280" }}>
                      💡 <strong>慢步骤标橙</strong>（防护&gt;50ms / 工具&gt;1.5s / LLM&gt;3s / 基础设施&gt;200ms），
                      <strong>失败步骤标红</strong>（边框 + ❌ 图标）。每条 Trace 顶部"自动诊断"会归纳 3-5 个关注点。
                    </div>
                  </div>
                ),
              },
            ]}
          />
        </Card>

        <Card style={{ marginTop: 16, borderRadius: 10 }} bordered={false}>
          <Space.Compact style={{ width: "100%" }}>
            <Input
              placeholder="输入 conversationId（或从下面会话列表点击）"
              value={conversationId}
              onChange={e => setConversationId(e.target.value)}
              onPressEnter={() => loadTrace()}
              prefix={<SearchOutlined />}
            />
            <Button type="primary" onClick={() => loadTrace()} loading={loading}>
              查询
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => loadTrace()} />
          </Space.Compact>

          {conversations.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                最近 {conversations.length} 个会话（🟣 已有 Trace · ⚪️ 暂无 Trace）：
              </Text>
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto" }}>
                {conversations.map(c => (
                  <div
                    key={c.id}
                    onClick={() => {
                      setConversationId(c.id);
                      loadTrace(c.id);
                    }}
                    style={{
                      cursor: "pointer",
                      padding: "6px 10px",
                      borderRadius: 6,
                      background: c.hasTrace ? "#f5f3ff" : "#fafafa",
                      border: c.hasTrace ? "1px solid #ddd6fe" : "1px solid #f0f0f0",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ width: 12 }}>{c.hasTrace ? "🟣" : "⚪️"}</span>
                    <span style={{ flex: 1, color: "#374151", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {c.title}
                    </span>
                    <code style={{ fontFamily: "monospace", fontSize: 11, color: "#9ca3af" }}>
                      {c.id.slice(0, 16)}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {initialLoading && (
          <Card style={{ marginTop: 16, borderRadius: 10 }} bordered={false}>
            <Skeleton active paragraph={{ rows: 6 }} />
          </Card>
        )}

        {loading && (
          <Card style={{ marginTop: 16, borderRadius: 10 }} bordered={false}>
            <Skeleton active paragraph={{ rows: 4 }} />
          </Card>
        )}

        {!initialLoading && !loading && traces.length === 0 && (
          <Card style={{ marginTop: 16, borderRadius: 10 }} bordered={false}>
            <Empty description="无 trace 数据，发起一次 Chat 对话后再试" />
          </Card>
        )}

        {traces.map(trace => {
          const t0 = trace.startTime;
          const totalMs = trace.totalMs || 1;
          const diagnosis = diagnose(trace);
          const isHighlight = urlTraceId && trace.traceId === urlTraceId;
          return (
            <div
              key={trace.traceId}
              ref={isHighlight ? highlightTraceRef : undefined}
              style={{ marginTop: 16 }}
            >
              <Card
                style={{
                  borderRadius: 10,
                  overflow: "hidden",
                  ...(isHighlight
                    ? { border: "2px solid #8b5cf6", boxShadow: "0 0 0 4px rgba(139, 92, 246, 0.12)" }
                    : {}),
                }}
                styles={{ body: { overflow: "hidden" } }}
                bordered={false}
                title={
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                    <Tag color="purple" style={{ fontFamily: "monospace", fontSize: 11, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {trace.traceId}
                    </Tag>
                    {isHighlight && (
                      <Tag color="magenta" style={{ fontSize: 11 }}>📍 来自 Chat 跳转</Tag>
                    )}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {trace.spanCount} 步 · {totalMs}ms · user={trace.userId}
                    </Text>
                  </div>
                }
              >
              {/* ============ 自动诊断卡片 ============ */}
              {diagnosis.length > 0 && (
                <div
                  style={{
                    marginBottom: 14,
                    padding: 10,
                    background: "#fafafa",
                    borderRadius: 6,
                    border: "1px solid #f0f0f0",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <Text strong style={{ fontSize: 12, color: "#6b7280" }}>📊 自动诊断</Text>
                  {diagnosis.map((d, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: 12,
                        color: d.type === "warning" ? "#d97706" : d.type === "success" ? "#16a34a" : "#374151",
                      }}
                    >
                      {d.text}
                    </div>
                  ))}
                </div>
              )}

              {/* ============ 时间轴 ============ */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "monospace", fontSize: 12, minWidth: 0, width: "100%", overflow: "hidden" }}>
                {trace.spans.map(span => {
                  const offset = ((span.startTime - t0) / totalMs) * 100;
                  const width = Math.max(0.5, ((span.durationMs || 1) / totalMs) * 100);
                  const meta = spanMeta(span.name);
                  const slowThresh = SLOW_MS_BY_CATEGORY[meta.category] ?? 1000;
                  const isSlow = (span.durationMs ?? 0) > slowThresh;
                  const isError = span.status === "error";
                  const barColor = isError ? "#dc2626" : isSlow ? "#f59e0b" : meta.color;

                  const importantAttrs = Object.entries(span.attributes || {})
                    .filter(([k, v]) => {
                      if (v === null || v === undefined || v === "") return false;
                      // 优先显示关键指标
                      return ["model", "firstByteMs", "chunkCount", "totalMs", "hits", "maxRisk", "action", "tool", "resultsCount", "tier", "category"].includes(k);
                    })
                    .slice(0, 3)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(" · ");

                  const allAttrs = Object.entries(span.attributes || {})
                    .filter(([, v]) => v !== null && v !== undefined && v !== "")
                    .map(([k, v]) => `${k}=${v}`)
                    .join("\n");

                  return (
                    <Tooltip
                      key={span.spanId}
                      placement="left"
                      title={
                        <div style={{ fontSize: 12, maxWidth: 320 }}>
                          <div><strong>{meta.label}</strong> <code style={{ fontFamily: "monospace", opacity: 0.7 }}>{span.name}</code></div>
                          <div style={{ marginTop: 4 }}>{meta.explain}</div>
                          <div style={{ marginTop: 6 }}>耗时: <strong>{span.durationMs ?? "-"}ms</strong> {isSlow ? `（阈值 ${slowThresh}ms）` : ""}</div>
                          <div>状态: {span.status}</div>
                          {allAttrs && (
                            <div style={{ marginTop: 6, opacity: 0.8, whiteSpace: "pre-wrap", fontSize: 11 }}>{allAttrs}</div>
                          )}
                          {isError && span.attributes?.error && (
                            <div style={{ marginTop: 6, color: "#fca5a5", fontSize: 11 }}>错误: {String(span.attributes.error).slice(0, 200)}</div>
                          )}
                        </div>
                      }
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative", padding: "2px 0", minWidth: 0, width: "100%", overflow: "hidden" }}>
                        <div style={{ width: 180, flexShrink: 0, color: "#374151", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 12 }}>
                          {meta.label}
                        </div>
                        <div style={{ flex: 1, minWidth: 0, height: 22, background: "#f3f4f6", borderRadius: 3, position: "relative", overflow: "hidden" }}>
                          <div
                            style={{
                              position: "absolute",
                              left: `${Math.min(99.5, offset)}%`,
                              width: `${Math.min(100 - Math.min(99.5, offset), width)}%`,
                              maxWidth: "100%",
                              top: 0,
                              bottom: 0,
                              background: barColor,
                              opacity: 0.85,
                              borderRadius: 3,
                              boxSizing: "border-box",
                              border: isError ? "1px solid #dc2626" : isSlow ? "1px solid #f59e0b" : "none",
                              display: "flex",
                              alignItems: "center",
                              paddingLeft: 6,
                              color: "#fff",
                              fontSize: 10,
                              overflow: "hidden",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {width > 15 && importantAttrs && (
                              <span style={{ opacity: 0.95, overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
                                {importantAttrs.slice(0, 50)}
                              </span>
                            )}
                          </div>
                          {isError && (
                            <div style={{ position: "absolute", right: 4, top: 2, fontSize: 11, color: "#dc2626", pointerEvents: "none" }}>❌</div>
                          )}
                          {isSlow && !isError && (
                            <div style={{ position: "absolute", right: 4, top: 2, fontSize: 11, color: "#d97706", pointerEvents: "none" }}>⚠️</div>
                          )}
                        </div>
                        <div style={{ width: 70, flexShrink: 0, textAlign: "right", color: isSlow ? "#d97706" : "#6b7280", fontWeight: isSlow ? 600 : 400 }}>
                          {span.durationMs ?? "-"}ms
                        </div>
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
              </Card>
            </div>
          );
        })}
      </div>
      <BottomNav />
    </div>
  );
}
