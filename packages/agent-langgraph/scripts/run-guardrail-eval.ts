/**
 * GuardRail 评估脚本 —— L1 输入注入 + L2 工具参数 的量化回归
 *
 * 为什么有这个脚本：
 *   早期项目只有 RAG 三个量化指标，GuardRail 全是定性描述。
 *   这里给 L1/L2 一套**确定性、零外部依赖、可复现**的量化基线：
 *     - 拦截率 (recall)  = 恶意样本中被 action!=allow 拦下的比例
 *     - 误拦率 (FPR)     = 良性样本中被误拦的比例
 *     - 动作精确匹配率   = action 与人工标注 expect 完全一致的比例
 *
 * 说明 / 局限（诚实标注）：
 *   - L3 输出层是异步观测、不做拦截，且依赖 RAG 上下文，不在本离线集内
 *   - 60 题规模只表达方向性结论；扩到 1000+ 与接 CI 属路线图
 *   - 规则型防护，结果完全确定（同输入恒同输出），无 LLM 抖动
 *
 * 用法：
 *   pnpm --filter @tech-mate/agent-langgraph exec tsx scripts/run-guardrail-eval.ts
 */

import * as fs from "fs";
import * as path from "path";

import { checkInput } from "../src/guardrail/input-guard";
import { checkToolInvocation } from "../src/guardrail/tool-guard";

interface EvalItem {
  id: string;
  layer: "input" | "tool";
  input?: string;
  tool?: string;
  args?: Record<string, any>;
  expect: "block" | "sanitize" | "allow";
  tag: string;
}

const EVAL_SET_PATH = path.resolve(__dirname, "../../../scripts/eval/guardrail-eval-set.jsonl");
const RESULTS_PATH = path.resolve(__dirname, "../../../scripts/eval/guardrail-results.json");

function loadSet(): EvalItem[] {
  const lines = fs.readFileSync(EVAL_SET_PATH, "utf-8").trim().split("\n");
  return lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** 展开数据集里的体积哨兵，避免在 jsonl 里塞几千字符 */
function expandSentinel(v: string): string {
  if (v === "__LONG__") return "a".repeat(4100); // > maxInputLength(4000)
  if (v === "__LONGQ__") return "x".repeat(600); // > web_search schema max(500)
  return v;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function main() {
  const set = loadSet();
  console.log("=".repeat(64));
  console.log(`GuardRail 评估 —— ${set.length} 题（L1 输入 / L2 工具，确定性）`);
  console.log("=".repeat(64));

  type Row = {
    id: string;
    layer: string;
    tag: string;
    expect: string;
    action: string;
    malicious: boolean;
    detected: boolean;
    exact: boolean;
  };
  const rows: Row[] = [];

  for (const item of set) {
    let action: string;
    if (item.layer === "input") {
      const r = checkInput(expandSentinel(item.input ?? ""));
      action = r.action;
    } else {
      const args: Record<string, any> = {};
      for (const [k, v] of Object.entries(item.args ?? {})) {
        args[k] = typeof v === "string" ? expandSentinel(v) : v;
      }
      const r = checkToolInvocation(item.tool ?? "", args);
      action = r.action; // tool 层只有 allow | block
    }
    const malicious = item.expect !== "allow";
    const detected = action !== "allow";
    rows.push({
      id: item.id,
      layer: item.layer,
      tag: item.tag,
      expect: item.expect,
      action,
      malicious,
      detected,
      exact: action === item.expect,
    });
  }

  const malicious = rows.filter((r) => r.malicious);
  const benign = rows.filter((r) => !r.malicious);

  const interceptRate = malicious.length
    ? malicious.filter((r) => r.detected).length / malicious.length
    : 0;
  const falseInterceptRate = benign.length
    ? benign.filter((r) => r.detected).length / benign.length
    : 0;
  const exactAccuracy = rows.filter((r) => r.exact).length / rows.length;

  const byLayer = (layer: string) => {
    const sub = rows.filter((r) => r.layer === layer);
    const mal = sub.filter((r) => r.malicious);
    const ben = sub.filter((r) => !r.malicious);
    return {
      total: sub.length,
      interceptRate: mal.length ? mal.filter((r) => r.detected).length / mal.length : 0,
      falseInterceptRate: ben.length ? ben.filter((r) => r.detected).length / ben.length : 0,
      exactAccuracy: sub.length ? sub.filter((r) => r.exact).length / sub.length : 0,
    };
  };

  const failures = rows.filter((r) => !r.exact);

  console.log(`\n样本：恶意 ${malicious.length} · 良性 ${benign.length}`);
  console.log(`拦截率 (recall)          : ${pct(interceptRate)}  (${malicious.filter((r) => r.detected).length}/${malicious.length})`);
  console.log(`误拦率 (FPR)             : ${pct(falseInterceptRate)}  (${benign.filter((r) => r.detected).length}/${benign.length})`);
  console.log(`动作精确匹配率           : ${pct(exactAccuracy)}  (${rows.filter((r) => r.exact).length}/${rows.length})`);
  console.log(`\n分层：`);
  for (const L of ["input", "tool"]) {
    const m = byLayer(L);
    console.log(
      `  ${L.padEnd(6)} 拦截率 ${pct(m.interceptRate)} · 误拦率 ${pct(m.falseInterceptRate)} · 精确 ${pct(m.exactAccuracy)} (${m.total} 题)`
    );
  }

  if (failures.length) {
    console.log(`\n未对齐样本 (${failures.length})：`);
    for (const f of failures) {
      console.log(`  ✗ ${f.id} [${f.layer}/${f.tag}] expect=${f.expect} got=${f.action}`);
    }
  } else {
    console.log(`\n✓ 全部 ${rows.length} 题动作与人工标注完全一致`);
  }

  const out = {
    timestamp: new Date().toISOString(),
    evalSetSize: rows.length,
    summary: {
      malicious: malicious.length,
      benign: benign.length,
      interceptRate,
      falseInterceptRate,
      exactAccuracy,
      byLayer: { input: byLayer("input"), tool: byLayer("tool") },
    },
    failures,
    rows,
  };
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2));
  console.log(`\n✓ 详细结果落盘: ${RESULTS_PATH}`);
}

main();
