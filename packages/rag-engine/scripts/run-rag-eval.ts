/**
 * RAG 评估脚本 —— 跑 3 个配置 + faithfulness 判断
 *
 * Config B: 纯向量（top-10）
 * Config C: 向量 + BM25 + RRF（无重排，top-10）
 * Config D: 向量 + BM25 + RRF + BGE-M3 重排（top-5）
 *
 * 指标：
 *   Recall@10 = 命中的 expected_doc / expected_doc 总数
 *   Precision@5 = top-5 里属于 expected_doc 的比例
 *   MRR = 1 / (第一个 expected_doc 的 rank)，找不到为 0
 *
 * 幻觉评估：
 *   No-RAG vs Full-RAG 各跑 10 题 → LLM-as-judge 打分 supported_facts / total_facts
 *   Hallucination rate = 1 - faithfulness
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// 加载 web 的 env（保证 DASHSCOPE_API_KEY / CHROMADB_URL 等环境变量可用）
dotenv.config({ path: path.resolve(__dirname, "../../web/.env") });

import { VectorRetriever } from "../src/retrievers/vector-retriever";
import { HybridFusionRetriever } from "../src/llamaindex/retrievers/hybrid-fusion-retriever";
import { BgeM3NodePostprocessor } from "../src/llamaindex/postprocessors/bge-m3-reranker";
import type { NodeWithScore } from "llamaindex";

interface EvalItem {
  id: string;
  category: string;
  question: string;
  expected_doc_ids: string[];
  expected_keywords: string[];
}

const EVAL_SET_PATH = path.resolve(__dirname, "../../../scripts/eval/rag-eval-set.jsonl");
const RESULTS_PATH = path.resolve(__dirname, "../../../scripts/eval/results.json");

function loadEvalSet(): EvalItem[] {
  const lines = fs.readFileSync(EVAL_SET_PATH, "utf-8").trim().split("\n");
  return lines.map((l) => JSON.parse(l));
}

// 抑制 chatty 的内部 console.log
const origLog = console.log;
const origWarn = console.warn;
function silenceLogs() {
  console.log = () => {};
  console.warn = () => {};
}
function restoreLogs() {
  console.log = origLog;
  console.warn = origWarn;
}

interface Metrics {
  recallAt10: number;
  precisionAt5: number;
  mrr: number;
}

function computeMetrics(retrievedIds: string[], expectedIds: string[]): Metrics {
  const expectedSet = new Set(expectedIds);
  // Recall@10
  const top10 = retrievedIds.slice(0, 10);
  const hits10 = top10.filter((id) => expectedSet.has(id)).length;
  const recallAt10 = expectedIds.length > 0 ? hits10 / expectedIds.length : 0;

  // Precision@5
  const top5 = retrievedIds.slice(0, 5);
  const hits5 = top5.filter((id) => expectedSet.has(id)).length;
  const precisionAt5 = hits5 / 5;

  // MRR
  let mrr = 0;
  for (let i = 0; i < retrievedIds.length; i++) {
    if (expectedSet.has(retrievedIds[i])) {
      mrr = 1 / (i + 1);
      break;
    }
  }

  return { recallAt10, precisionAt5, mrr };
}

async function runVectorOnly(question: string): Promise<string[]> {
  silenceLogs();
  try {
    const retriever = new VectorRetriever();
    const results = await retriever.search(question, { topK: 10 });
    return results.map((r) => r.id);
  } finally {
    restoreLogs();
  }
}

async function runHybridRRF(retriever: HybridFusionRetriever, question: string, topK: number): Promise<NodeWithScore[]> {
  silenceLogs();
  try {
    const nodes = await retriever.retrieve({ query: question });
    return nodes.slice(0, topK);
  } finally {
    restoreLogs();
  }
}

async function runWithRerank(
  retriever: HybridFusionRetriever,
  postprocessor: BgeM3NodePostprocessor,
  question: string
): Promise<NodeWithScore[]> {
  silenceLogs();
  try {
    const nodes = await retriever.retrieve({ query: question });
    const reranked = await postprocessor.postprocessNodes(nodes, { query: question });
    return reranked;
  } finally {
    restoreLogs();
  }
}

function nodesToIds(nodes: NodeWithScore[]): string[] {
  return nodes.map((n) => (n.node as any).id_ || (n.node as any).id).filter(Boolean);
}

// ============ LLM-judge for faithfulness ============
async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.DASHSCOPE_API_KEY!;
  const baseURL = process.env.LLM_BASE_URL_T2 || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const model = process.env.LLM_MODEL_T2 || "qwen-plus";
  const resp = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });
  if (!resp.ok) {
    throw new Error(`LLM HTTP ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as any;
  return data.choices?.[0]?.message?.content || "";
}

async function answerNoRAG(question: string): Promise<string> {
  return callLLM(
    "你是技术助手，根据你的知识回答用户的技术问题。",
    question
  );
}

async function answerWithRAG(question: string, contextDocs: string[]): Promise<string> {
  const context = contextDocs.map((c, i) => `[文档 ${i + 1}]\n${c}`).join("\n\n");
  return callLLM(
    "你是技术助手，严格基于下面提供的文档片段回答用户问题。如果文档里没有，明确说明。",
    `${context}\n\n问题：${question}`
  );
}

async function judgeFaithfulness(
  question: string,
  answer: string,
  evidence: string[]
): Promise<{ totalFacts: number; supportedFacts: number; faithfulness: number }> {
  const evidenceText = evidence.map((e, i) => `[E${i + 1}] ${e}`).join("\n");
  const judgePrompt = `你是 RAG 评估专家。请判断下面"待评答案"里包含多少个**独立事实陈述**（声明性技术陈述、数字、定义、流程步骤等），以及其中**多少个能被给定证据支持**（证据里能直接看到或合理推断）。

【问题】${question}

【证据】
${evidenceText}

【待评答案】
${answer}

请严格返回 JSON（不要任何其他文字）：
{"total_facts": <数字>, "supported_facts": <数字>, "brief_explanation": "<10 字内说明>"}`;
  const raw = await callLLM("你是严格的 RAG 评估专家。只输出 JSON。", judgePrompt);
  // 剥 markdown 包裹
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return { totalFacts: 1, supportedFacts: 0, faithfulness: 0 };
  }
  try {
    const parsed = JSON.parse(match[0]);
    const total = parsed.total_facts || 1;
    const supported = parsed.supported_facts || 0;
    return {
      totalFacts: total,
      supportedFacts: supported,
      faithfulness: total > 0 ? supported / total : 0,
    };
  } catch {
    return { totalFacts: 1, supportedFacts: 0, faithfulness: 0 };
  }
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ============ 主流程 ============
async function main() {
  console.log("=".repeat(72));
  console.log("RAG 评估开始 —— 30 题，3 个配置 + faithfulness");
  console.log("=".repeat(72));

  const evalSet = loadEvalSet();
  console.log(`✓ 加载 ${evalSet.length} 道题`);

  // 复用一个 hybrid retriever 避免反复构建 BM25 索引
  const hybridRetriever = new HybridFusionRetriever({ topK: 20 });
  // 预热（触发 BM25 lazy buildIndex）
  console.log("\n[预热] 触发 BM25 buildIndex…");
  silenceLogs();
  await hybridRetriever.retrieve({ query: "预热" }).catch(() => {});
  restoreLogs();
  console.log("✓ 预热完成");

  const postprocessor = new BgeM3NodePostprocessor({ topK: 5 });

  type RowMetrics = {
    id: string;
    category: string;
    question: string;
    expected: string[];
    vector: { ids: string[]; m: Metrics };
    hybrid: { ids: string[]; m: Metrics };
    full: { ids: string[]; m: Metrics };
  };
  const rows: RowMetrics[] = [];

  console.log("\n=== Phase 1: 检索评估 ===");
  for (let i = 0; i < evalSet.length; i++) {
    const item = evalSet[i];
    process.stdout.write(`[${i + 1}/${evalSet.length}] ${item.id} ${item.category} ... `);

    // Config B
    const bIds = await runVectorOnly(item.question);
    // Config C
    const cNodes = await runHybridRRF(hybridRetriever, item.question, 10);
    const cIds = nodesToIds(cNodes);
    // Config D
    const dNodes = await runWithRerank(hybridRetriever, postprocessor, item.question);
    const dIds = nodesToIds(dNodes);

    const row: RowMetrics = {
      id: item.id,
      category: item.category,
      question: item.question,
      expected: item.expected_doc_ids,
      vector: { ids: bIds, m: computeMetrics(bIds, item.expected_doc_ids) },
      hybrid: { ids: cIds, m: computeMetrics(cIds, item.expected_doc_ids) },
      full: { ids: dIds, m: computeMetrics(dIds, item.expected_doc_ids) },
    };
    rows.push(row);
    console.log(
      `vec[R10=${row.vector.m.recallAt10.toFixed(2)}] hyb[R10=${row.hybrid.m.recallAt10.toFixed(2)}] full[P5=${row.full.m.precisionAt5.toFixed(2)}]`
    );
  }

  // 汇总
  const summary = {
    vector: {
      recallAt10: avg(rows.map((r) => r.vector.m.recallAt10)),
      precisionAt5: avg(rows.map((r) => r.vector.m.precisionAt5)),
      mrr: avg(rows.map((r) => r.vector.m.mrr)),
    },
    hybrid: {
      recallAt10: avg(rows.map((r) => r.hybrid.m.recallAt10)),
      precisionAt5: avg(rows.map((r) => r.hybrid.m.precisionAt5)),
      mrr: avg(rows.map((r) => r.hybrid.m.mrr)),
    },
    full: {
      recallAt10: avg(rows.map((r) => r.full.m.recallAt10)),
      precisionAt5: avg(rows.map((r) => r.full.m.precisionAt5)),
      mrr: avg(rows.map((r) => r.full.m.mrr)),
    },
  };

  console.log("\n" + "=".repeat(72));
  console.log("Phase 1 结果（30 题平均）");
  console.log("=".repeat(72));
  console.log(
    `Config B (纯向量)            Recall@10=${(summary.vector.recallAt10 * 100).toFixed(1)}%   Precision@5=${(summary.vector.precisionAt5 * 100).toFixed(1)}%   MRR=${summary.vector.mrr.toFixed(3)}`
  );
  console.log(
    `Config C (向量+BM25+RRF)     Recall@10=${(summary.hybrid.recallAt10 * 100).toFixed(1)}%   Precision@5=${(summary.hybrid.precisionAt5 * 100).toFixed(1)}%   MRR=${summary.hybrid.mrr.toFixed(3)}`
  );
  console.log(
    `Config D (全链路+BGE-M3 重排) Recall@10=${(summary.full.recallAt10 * 100).toFixed(1)}%   Precision@5=${(summary.full.precisionAt5 * 100).toFixed(1)}%   MRR=${summary.full.mrr.toFixed(3)}`
  );

  // ============ Phase 2: Faithfulness ============
  console.log("\n=== Phase 2: 幻觉率评估（10 题，No-RAG vs Full-RAG）===");
  const faithSubset = evalSet.slice(0, 10);
  type FaithRow = {
    id: string;
    question: string;
    noRagFaith: number;
    ragFaith: number;
  };
  const faithRows: FaithRow[] = [];

  for (let i = 0; i < faithSubset.length; i++) {
    const item = faithSubset[i];
    process.stdout.write(`[${i + 1}/10] ${item.id} ... `);

    // 获取 Full 检索的证据
    const dNodes = await runWithRerank(hybridRetriever, postprocessor, item.question);
    const evidence = dNodes.map((n) => (n.node as any).text || "");

    // 生成答案
    const [noRagAnswer, ragAnswer] = await Promise.all([
      answerNoRAG(item.question),
      answerWithRAG(item.question, evidence),
    ]);

    // 双答案分别让 judge 评分
    const [noRagJudge, ragJudge] = await Promise.all([
      judgeFaithfulness(item.question, noRagAnswer, evidence),
      judgeFaithfulness(item.question, ragAnswer, evidence),
    ]);

    faithRows.push({
      id: item.id,
      question: item.question,
      noRagFaith: noRagJudge.faithfulness,
      ragFaith: ragJudge.faithfulness,
    });
    console.log(`noRAG=${(noRagJudge.faithfulness * 100).toFixed(0)}%  withRAG=${(ragJudge.faithfulness * 100).toFixed(0)}%`);
  }

  const noRagAvg = avg(faithRows.map((r) => r.noRagFaith));
  const ragAvg = avg(faithRows.map((r) => r.ragFaith));

  console.log("\n" + "=".repeat(72));
  console.log("Phase 2 结果（10 题平均）");
  console.log("=".repeat(72));
  console.log(`No-RAG 答案 faithfulness:  ${(noRagAvg * 100).toFixed(1)}%   → hallucination=${((1 - noRagAvg) * 100).toFixed(1)}%`);
  console.log(`Full-RAG 答案 faithfulness: ${(ragAvg * 100).toFixed(1)}%   → hallucination=${((1 - ragAvg) * 100).toFixed(1)}%`);

  // ============ 落盘 ============
  const out = {
    timestamp: new Date().toISOString(),
    evalSetSize: evalSet.length,
    phase1: { summary, rows },
    phase2: {
      summary: {
        noRagFaithfulness: noRagAvg,
        ragFaithfulness: ragAvg,
        noRagHallucination: 1 - noRagAvg,
        ragHallucination: 1 - ragAvg,
      },
      rows: faithRows,
    },
  };
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2));
  console.log(`\n✓ 详细结果已落盘: ${RESULTS_PATH}`);
}

main().catch((e) => {
  console.error("\n❌ 评估失败:", e);
  process.exit(1);
});
