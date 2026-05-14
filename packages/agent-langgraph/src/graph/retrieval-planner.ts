/**
 * P4-A · 检索调度器（模型自主工具决策 / function calling）
 *
 * 早期设计问题：web_search 由关键词正则硬触发，模型全程没参与决策。
 * 这里把 general_qa 里两个硬编码决策点合成**一次结构化模型决策**：
 *   1. 要不要查本地知识库（kb_retrieve）
 *   2. 要不要联网搜索（web_search）
 *   3. 顺带做查询重写（refined_query）—— 教科书级 agent 行为
 *
 * 设计底线（诚实，不滑向 ReAct 循环）：
 *   - **只调用一次**，不做多轮 Thought→Action（那是 Plan B/C）
 *   - 解析失败 → modelDecided=false，调用方回退原启发式，**零风险降级**
 *   - 用便宜的 T1 档（qwen-turbo），低延迟低成本
 */

import { logger } from "@tech-mate/core";
import { chatLLM } from "../llm/client";

export interface RetrievalDecision {
  /** 是否需要本地技术知识库 */
  useKb: boolean;
  /** 是否需要联网搜索 */
  useWeb: boolean;
  /** 检索友好的改写 query（无需检索时回退原问题） */
  refinedQuery: string;
  /** 模型给出的一句话理由 */
  reason: string;
  /** true=模型真实决策；false=解析失败，调用方应回退启发式 */
  modelDecided: boolean;
}

const SYSTEM_PROMPT = `你是一个检索调度器。基于用户问题，决定回答它需要调用哪些检索工具，并把问题改写成更适合检索的查询。

可用工具：
- kb_retrieve：本地技术知识库。**覆盖并不全**：偏 Agent / RAG / LangChain / 大模型工程类沉淀，前端基础、语言细节等不一定有。问技术"概念 / 原理 / 怎么做 / 区别"可以用它，但**不要假设它什么都有**。
- web_search：联网实时搜索。时效性问题（最新 / 今年 / 2026 / 某公司数据 / 新闻 / 版本发布日期）必用；本地库可能覆盖不到的普通技术问题也用它兜底。

判断规则（宁可多查一次 web，也别因"以为本地库有"而漏）：
- 纯闲聊 / 问候 / 情绪倾诉 / 与技术无关 → 两个工具都不用。
- 技术概念 / 原理 / 对比 / 怎么做 → kb_retrieve = true；**同时** web_search 也置 true 兜底，**除非**该问题明显属于上面列的 Agent/RAG/LangChain/大模型工程领域（那才可只用 kb）。基础语言/前端/算法等不确定是否在库里的，一律 kb + web 双开。
- 时效性 / 最新动态 / 具体新闻数字 → web_search 必 true（涉及基础概念可同时 kb）。
（说明：下游对低置信检索还有 tier 兜底，但你这一步遇到"不确定本地库是否覆盖"时就应偏向把 web 也开上，不要赌。）
- refined_query：把口语化、含指代的问题改写成关键词式检索 query（如"这玩意为啥这么慢" → "React 重渲染 性能优化"）；都不需要检索时给空字符串。

只输出 JSON，不要任何多余文字、不要 markdown 代码块：
{"kb": true或false, "web": true或false, "refined_query": "改写后的查询或空串", "reason": "一句话理由"}`;

/**
 * 调一次 LLM 做检索决策。失败时返回 modelDecided=false（调用方回退启发式）。
 */
export async function planRetrieval(question: string): Promise<RetrievalDecision> {
  try {
    const { content } = await chatLLM({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question },
      ],
      tier: "T1", // 便宜快档，决策不需要强模型
      temperature: 0,
      maxTokens: 200,
    });

    const stripped = content
      .replace(/^\s*```(?:json)?/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`无法从 LLM 输出解析 JSON: ${content.slice(0, 120)}`);

    const obj = JSON.parse(match[0]);
    const refined =
      typeof obj.refined_query === "string" && obj.refined_query.trim().length > 0
        ? obj.refined_query.trim()
        : question;

    return {
      useKb: obj.kb === true,
      useWeb: obj.web === true,
      refinedQuery: refined,
      reason: typeof obj.reason === "string" ? obj.reason.slice(0, 80) : "",
      modelDecided: true,
    };
  } catch (err) {
    logger.warn(
      `[RetrievalPlanner] 决策失败，调用方将回退启发式: ${err instanceof Error ? err.message : String(err)}`
    );
    return {
      useKb: false,
      useWeb: false,
      refinedQuery: question,
      reason: "planner 不可用 → 回退关键词启发式",
      modelDecided: false,
    };
  }
}
