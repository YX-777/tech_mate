/**
 * P4-A 工具决策评估 —— 量化"模型自主决定调哪个工具"的准确率
 *
 * 补充工具调用的量化指标。注意诚实边界：
 *   - 依赖 LLM（同 run-rag-eval，需要 DASHSCOPE_API_KEY），有 ±抖动
 *   - 24 题小集只表达方向性，**不写 >90% 这类指标进简历**
 *   - kb / web 两个决策分别算准确率，再算 exact（两个都对）
 *
 * 用法：
 *   pnpm --filter @tech-mate/agent-langgraph exec tsx scripts/run-tool-decision-eval.ts
 */

import * as fs from "fs";
import * as path from "path";

// 极简 .env 加载（不引第三方依赖）：读 packages/web/.env 注入 process.env
function loadEnv() {
  const envPath = path.resolve(__dirname, "../../web/.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

// 必须在 env 加载后再 import（client 读 process.env）
import { planRetrieval } from "../src/graph/retrieval-planner";

interface Item {
  id: string;
  question: string;
  expect_kb: boolean;
  expect_web: boolean;
  tag: string;
}

const SET_PATH = path.resolve(__dirname, "../../../scripts/eval/tool-decision-eval-set.jsonl");
const OUT_PATH = path.resolve(__dirname, "../../../scripts/eval/tool-decision-results.json");

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const set: Item[] = fs
    .readFileSync(SET_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  console.log("=".repeat(64));
  console.log(`P4-A 工具决策评估 —— ${set.length} 题（LLM 决策，有抖动）`);
  console.log("=".repeat(64));

  const rows: any[] = [];
  for (let i = 0; i < set.length; i++) {
    const it = set[i];
    process.stdout.write(`[${i + 1}/${set.length}] ${it.id} ... `);
    const d = await planRetrieval(it.question);
    const kbOk = d.useKb === it.expect_kb;
    const webOk = d.useWeb === it.expect_web;
    const exact = kbOk && webOk;
    rows.push({
      id: it.id,
      tag: it.tag,
      question: it.question,
      expect: { kb: it.expect_kb, web: it.expect_web },
      got: { kb: d.useKb, web: d.useWeb, modelDecided: d.modelDecided, refinedQuery: d.refinedQuery },
      kbOk,
      webOk,
      exact,
    });
    console.log(`kb ${d.useKb}(${kbOk ? "✓" : "✗"}) web ${d.useWeb}(${webOk ? "✓" : "✗"})`);
  }

  const n = rows.length;
  const kbAcc = rows.filter((r) => r.kbOk).length / n;
  const webAcc = rows.filter((r) => r.webOk).length / n;
  const exactAcc = rows.filter((r) => r.exact).length / n;
  const modelDecidedRate = rows.filter((r) => r.got.modelDecided).length / n;

  console.log("\n" + "=".repeat(64));
  console.log(`KB 决策准确率   : ${pct(kbAcc)}`);
  console.log(`Web 决策准确率  : ${pct(webAcc)}`);
  console.log(`两者全对 (exact): ${pct(exactAcc)}`);
  console.log(`模型成功决策率  : ${pct(modelDecidedRate)}（其余回退启发式）`);

  const fails = rows.filter((r) => !r.exact);
  if (fails.length) {
    console.log(`\n未对齐 (${fails.length})：`);
    for (const f of fails) {
      console.log(
        `  ✗ ${f.id} [${f.tag}] "${f.question}" expect kb=${f.expect.kb} web=${f.expect.web} | got kb=${f.got.kb} web=${f.got.web}`
      );
    }
  }

  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        evalSetSize: n,
        summary: { kbAcc, webAcc, exactAcc, modelDecidedRate },
        rows,
      },
      null,
      2
    )
  );
  console.log(`\n✓ 详细结果落盘: ${OUT_PATH}`);
}

main().catch((e) => {
  console.error("\n❌ 评估失败:", e);
  process.exit(1);
});
