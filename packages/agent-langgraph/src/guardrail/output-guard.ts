/**
 * L3 OutputGuard —— 输出端相关性 + 幻觉交叉验证
 *
 * 设计：
 *   1. 相关性：用 embedding cosine sim 计算「用户问题 ↔ Agent 回答」
 *      - 低于 threshold 标记 LOW_RELEVANCE（可能跑题）
 *   2. 幻觉交叉验证：抽取回答中的事实陈述（启发式：含数字、人名、版本号、API 名称等），
 *      与 RAG 检索结果做字符串覆盖判断
 *      - 命中率 < threshold 标记 LOW_FACT_COVERAGE
 *
 * 关键：**异步执行，不阻塞流式输出**
 *   - 流式输出已经回给用户了
 *   - L3 仅 fire-and-forget 写日志 + 落 OTel span
 *   - UI 在最终的 done 事件附带 guardrail 结果（用户可看到"🛡️ 已通过 3 层防护"）
 *
 *   "L3 用 embedding 算相关性 + 启发式抽取事实交叉验证 RAG 命中，
 *    一来证明回答没跑题，二来对幻觉做兜底监控。
 *    为了不破坏流式 UX，整个 L3 是异步触发的，结果只用于观测+UI 徽章。"
 */

import { DEFAULT_POLICIES } from "./policies";
import type { GuardHit, GuardResult } from "./types";
import { getCurrentTrace } from "../otel/async-context";
import { logAgentEvent } from "../utils/event-logger";
import { semanticSimilarity } from "../utils/semantic-sim";

export interface RAGSourceSnippet {
  content: string;
  title?: string;
  url?: string;
}

export interface OutputGuardInput {
  question: string;
  answer: string;
  ragSources?: RAGSourceSnippet[];
  /** 可选：注入一个 cosine sim 函数（避免硬编码 embedding service） */
  computeSim?: (a: string, b: string) => Promise<number> | number;
  userId?: string;
  conversationId?: string;
}

/** 极简事实片段抽取：
 *   1. 含数字 / 百分比 / 年份的句子
 *   2. 含特定大写连续词（人名、API、库名、版本号）
 *   返回去重后的句子列表，最多 8 条
 */
export function extractFactualClaims(answer: string): string[] {
  // 按句子切分（中文 + 英文）
  const sentences = answer
    .split(/(?<=[。！？!?；;\n])/)
    .map(s => s.trim())
    .filter(s => s.length >= 6 && s.length <= 200);

  const factualPattern = /(\d+%?|\d+\.\d+|v?\d+\.\d+(?:\.\d+)?|20\d{2}|[A-Z][a-zA-Z0-9]{2,})/;
  const claims = new Set<string>();
  for (const s of sentences) {
    if (factualPattern.test(s)) {
      claims.add(s);
      if (claims.size >= 8) break;
    }
  }
  return Array.from(claims);
}

/** 朴素事实覆盖率：claim 中任一关键字段是否被 RAG 内容覆盖 */
export function computeFactCoverage(claims: string[], sources: RAGSourceSnippet[]): {
  ratio: number;
  uncoveredClaims: string[];
} {
  if (claims.length === 0) return { ratio: 1, uncoveredClaims: [] };
  if (sources.length === 0) return { ratio: 0, uncoveredClaims: [...claims] };

  const corpus = sources.map(s => s.content).join("\n").toLowerCase();
  const uncovered: string[] = [];
  let coveredCount = 0;

  for (const claim of claims) {
    // 抽取 claim 中的关键片段：数字 / 大写词 / 长中文 token
    const tokens = claim.match(/(\d+\.?\d*%?|v?\d+\.\d+(?:\.\d+)?|[A-Z][a-zA-Z0-9]{2,}|[一-龥]{2,})/g) || [];
    // 至少要有 1 个 token 出现在 corpus 才算覆盖
    const isCovered = tokens.some(tok => corpus.includes(tok.toLowerCase()));
    if (isCovered) coveredCount++;
    else uncovered.push(claim);
  }

  return { ratio: coveredCount / claims.length, uncoveredClaims: uncovered };
}

/**
 * 输出验证（异步，不阻塞主流程）
 */
export async function checkOutput(input: OutputGuardInput): Promise<GuardResult> {
  const t0 = Date.now();
  const policies = DEFAULT_POLICIES;
  const hits: GuardHit[] = [];

  // ---- 1) 相关性检查（语义余弦）----
  // 口径：cosine(embedding(问题), embedding(答案))，DashScope text-embedding-v2 1536 维。
  //   旧实现是 Jaccard 词面重合 —— 短问题 vs 长答案恒趋近 0，误报 "相关性 1%"。
  //   已删掉原 questionLen<8 的跳过 hack（那是 Jaccard 时代的补丁，embedding 对短文本不失真）。
  //   仍仅在有可对照知识源时做整套 L3（与 fact-coverage 的 applied 口径一致）。
  //   embedding 不可用 → simScore=null → 不误报、诚实标注"未计算"（绝不写死分数）。
  const hasRagContext = (input.ragSources ?? []).length > 0;
  const skipRelevance = !hasRagContext;
  let simScore: number | null = null;
  if (!skipRelevance) {
    simScore = input.computeSim
      ? await input.computeSim(input.question, input.answer)
      : await semanticSimilarity(input.question, input.answer);
  }

  if (simScore !== null && simScore < policies.relevanceThreshold) {
    hits.push({
      ruleId: "out-low-relevance",
      ruleName: "low-relevance",
      layer: "output",
      risk: "medium",
      reason: `回答与问题语义相关性偏低（cosine=${simScore.toFixed(3)} < ${policies.relevanceThreshold}）`,
    });
  }

  // ---- 2) 事实交叉验证 ----
  // 关键修正：若用户问题根本没走 RAG（web 搜索 / 普通对话 / 创意任务），
  //          没有 ground truth 可对照，不应该判幻觉。只在有 RAG 来源时才做这一步。
  const claims = extractFactualClaims(input.answer);
  const { ratio, uncoveredClaims } = hasRagContext
    ? computeFactCoverage(claims, input.ragSources ?? [])
    : { ratio: 1, uncoveredClaims: [] as string[] };

  if (hasRagContext && claims.length > 0 && ratio < policies.factVerificationRatio) {
    hits.push({
      ruleId: "out-low-fact-coverage",
      ruleName: "low-fact-coverage",
      layer: "output",
      risk: "medium",
      reason: `事实陈述中只有 ${(ratio * 100).toFixed(0)}% 能被知识源印证（阈值 ${(policies.factVerificationRatio * 100).toFixed(0)}%）`,
    });
  }

  // L3 是否真正执行了校验：只有存在可对照的知识源（kb / web）时才有意义。
  // 纯闲聊 / 创意 / 任务规划没有 ground truth —— 此时**诚实上报"未校验"**，
  // 绝不把 similarity / factCoverage 写死成 1.0 再亮绿盾（P1 修复点）。
  const outputCheckApplied = hasRagContext;

  const result: GuardResult = {
    layer: "output",
    passed: hits.length === 0,
    hits,
    maxRisk: hits.length === 0 ? "low" : "medium",
    action: "allow", // L3 永远 allow，仅记录
    metadata: {
      applied: outputCheckApplied,
      similarity: simScore ?? undefined,
      factClaims: claims.length,
      factCoverage: outputCheckApplied ? ratio : undefined,
      uncoveredSample: uncoveredClaims.slice(0, 3),
    },
    durationMs: Date.now() - t0,
  };

  const trace = getCurrentTrace();
  if (trace) {
    const span = trace.startSpan("guardrail.output");
    span.setAttributes({
      applied: outputCheckApplied,
      similarity: simScore == null ? -1 : Number(simScore.toFixed(3)),
      factClaims: claims.length,
      factCoverage: outputCheckApplied ? Number(ratio.toFixed(3)) : -1,
      hits: hits.length,
    });
    trace.endSpan(span, "success");
  }

  if (input.userId) {
    logAgentEvent({
      userId: input.userId,
      conversationId: input.conversationId,
      eventType: "guardrail",
      eventName: "output_check",
      payload: {
        layer: "output",
        applied: outputCheckApplied,
        similarity: simScore,
        factCoverage: outputCheckApplied ? ratio : null,
        claimsCount: claims.length,
        hits: hits.map(h => ({ id: h.ruleId, risk: h.risk, reason: h.reason })),
      },
      durationMs: result.durationMs,
    });
  }

  return result;
}
