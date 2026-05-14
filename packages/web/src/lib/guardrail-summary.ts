/**
 * GuardRail 统一三态摘要 —— **纯函数单一来源**。
 *
 * 为什么独立成模块（而不是塞在 route handler 里）：
 *  - route.ts 那段是典型"补丁摞补丁"的历史遗留，L3 早年存在"伪装通过"问题，
 *    后打了 applied 特例，L1/L2 仍是二元 + 新的 SSRF 短路游离在外。
 *  - 抽成纯函数后：逻辑可确定性单测（无 LLM 抖动，可现场复跑，纳入版本控制），
 *    route.ts 只负责"采信号"，MessageBubble 只负责"渲染"，职责干净。
 *
 * 核心原则：每层一视同仁四态；N/A 必须诚实标 skip，**绝不伪装成 pass**；
 *           决定请求命运的层标 block（徽章据此做标题，不再把拦截包装成通过）。
 */
import type { GuardRailSummary, GuardLayerResult } from "../types";

/** route handler 采集到的原始信号（来自 trace span + l1 + l3），与上下文解耦 */
export interface GuardSignals {
  /** 输入侧 SSRF/内网短路（nodes.ts 写的 guardrail.input 错误 span）；无则 null */
  inputBlock?: { reason?: string; maxRisk?: string } | null;
  /** L1 注入检测（route.ts:404 checkInput 的结果） */
  l1: { hitCount: number; maxRisk?: string; action?: string };
  /** L2 工具参数校验：ran=本次是否真的调过工具（有无 guardrail.tool span） */
  l2: { ran: boolean; blocks: Array<{ tool: string; maxRisk: string; hits: any[] }> };
  /** L3 输出观测：applied=false 表示本场景无来源可对照 */
  l3: { applied?: boolean; passed: boolean; hitCount: number; similarity?: number; factCoverage?: number };
}

export function buildGuardrailSummary(s: GuardSignals): GuardRailSummary {
  const input: GuardLayerResult = s.inputBlock
    ? {
        state: "block",
        detail: `输入侧拦截：${s.inputBlock.reason || "SSRF / 内网访问"}`,
        hits: 1,
        maxRisk: s.inputBlock.maxRisk || "high",
      }
    : s.l1.hitCount > 0
      ? {
          state: "warn",
          detail: s.l1.action === "sanitize" ? "命中中风险，已脱敏后继续" : "命中输入告警",
          hits: s.l1.hitCount,
          maxRisk: s.l1.maxRisk,
        }
      : { state: "pass", detail: "无注入特征", hits: 0, maxRisk: s.l1.maxRisk };

  const tool: GuardLayerResult =
    s.l2.blocks.length > 0
      ? { state: "block", detail: `拦截 ${s.l2.blocks.length} 次工具调用`, blocks: s.l2.blocks }
      : s.l2.ran
        ? { state: "pass", detail: "工具参数校验通过（Zod schema + 黑名单）" }
        : { state: "skip", detail: "本次未调用外部工具，无需参数校验" };

  const output: GuardLayerResult =
    s.l3.applied === false
      ? { state: "skip", detail: "本场景无知识库 / 网页来源可对照，未做事实校验" }
      : !s.l3.passed
        ? {
            state: "warn",
            detail: "输出观测命中告警（L3 只标注不阻断）",
            hits: s.l3.hitCount,
            similarity: s.l3.similarity,
            factCoverage: s.l3.factCoverage,
          }
        : {
            state: "pass",
            detail: "输出语义/事实校验通过",
            hits: 0,
            similarity: s.l3.similarity,
            factCoverage: s.l3.factCoverage,
          };

  return { input, tool, output };
}

/**
 * 旧消息兼容适配：历史 message.metadata 是老结构
 * { input:{passed,hits,maxRisk}, tool:{count,blocks}, output:{passed,hits,applied,...} }。
 * 映射到统一三态，保证翻历史会话徽章不崩；**未知状态诚实降级，绝不伪绿**。
 */
export function normalizeGuard(g: any): GuardRailSummary {
  const inp = g?.input ?? {};
  const tl = g?.tool ?? {};
  const out = g?.output ?? {};
  // 已是新模型（有 state 字段）直接用
  if (typeof inp.state === "string") return g as GuardRailSummary;

  const input: GuardLayerResult = inp.passed
    ? { state: "pass", detail: "无注入特征", hits: 0, maxRisk: inp.maxRisk }
    : { state: "warn", detail: "命中输入告警", hits: inp.hits ?? 0, maxRisk: inp.maxRisk };

  const tool: GuardLayerResult =
    (tl.count ?? 0) > 0
      ? { state: "block", detail: `拦截 ${tl.count} 次工具调用`, blocks: tl.blocks }
      : // 旧数据无法回溯"工具到底跑没跑"——诚实降级为未记录，不伪装通过
        { state: "skip", detail: "历史消息·工具校验状态未记录" };

  const output: GuardLayerResult =
    out.applied === false
      ? { state: "skip", detail: "本场景无来源可对照，未做事实校验" }
      : out.passed === false
        ? { state: "warn", detail: "输出观测命中告警", hits: out.hits ?? 0, similarity: out.similarity, factCoverage: out.factCoverage }
        : { state: "pass", detail: "输出校验通过", hits: 0, similarity: out.similarity, factCoverage: out.factCoverage };

  return { input, tool, output };
}
