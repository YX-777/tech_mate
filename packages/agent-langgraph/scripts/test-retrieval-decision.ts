/**
 * 检索使用决策 —— 确定性回归（无 LLM / 无 DB，纯逻辑）
 *
 * 锁死本次 A+B1 修复：
 *  - 闭包 bug 复刻：tier=expand 且模型 useWeb=false → **必须**转联网兜底
 *    且 expand 的 KB 残渣不算可信命中（不上桌当参考来源）
 *  - candidates → 也联网（B1 双源交叉核对）
 *  - precise → 不自动联网（除非模型/启发式另外要）
 *  - 任务查询 → 永不联网
 *
 * 用法：pnpm --filter @tech-mate/agent-langgraph exec tsx scripts/test-retrieval-decision.ts
 */
import { isKbConfident, tierWantsWeb, decideWeb } from "../src/graph/retrieval-decision";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${got !== undefined ? ` —— got: ${JSON.stringify(got)}` : ""}`);
  }
}

console.log("=".repeat(64));
console.log("检索使用决策 回归（A 治本 + B1 多源）");
console.log("=".repeat(64));

console.log("\n[1] isKbConfident —— 只有 precise/candidates 且有结果算可信命中");
check("precise+有结果 → true", isKbConfident("precise", 3) === true);
check("candidates+有结果 → true", isKbConfident("candidates", 5) === true);
check("expand+有结果 → false（17% 垃圾不上桌）", isKbConfident("expand", 5) === false);
check("fallback → false", isKbConfident("fallback", 0) === false);
check("precise 但 0 结果 → false", isKbConfident("precise", 0) === false);
check("空 tier → false", isKbConfident("", 3) === false);

console.log("\n[2] tierWantsWeb —— expand/fallback 兜底 + candidates 多源");
check("expand → true", tierWantsWeb("expand") === true);
check("fallback → true", tierWantsWeb("fallback") === true);
check("candidates → true（B1）", tierWantsWeb("candidates") === true);
check("precise → false（不自动联网）", tierWantsWeb("precise") === false);
check("空 tier → false", tierWantsWeb("") === false);

console.log("\n[3] decideWeb —— 闭包 bug 核心回归");
// 闭包场景：模型判 useKb=true/useWeb=false（非回退），RAG 回来 expand
check(
  "★ tier=expand + 模型useWeb=false + 非回退 → 转联网（A 治本，闭包修复）",
  decideWeb({ isTaskQuery: false, modelUseWeb: false, planFellBack: false, heuristicWeb: false, tier: "expand" }) === true
);
check(
  "tier=fallback + 模型useWeb=false → 转联网兜底",
  decideWeb({ isTaskQuery: false, modelUseWeb: false, planFellBack: false, heuristicWeb: false, tier: "fallback" }) === true
);
check(
  "tier=candidates + 模型useWeb=false → 也联网（B1 双源）",
  decideWeb({ isTaskQuery: false, modelUseWeb: false, planFellBack: false, heuristicWeb: false, tier: "candidates" }) === true
);
check(
  "tier=precise + 模型useWeb=false + 非回退 + 无启发式 → 不自动联网",
  decideWeb({ isTaskQuery: false, modelUseWeb: false, planFellBack: false, heuristicWeb: false, tier: "precise" }) === false
);

console.log("\n[4] decideWeb —— 其它分支");
check(
  "任务查询 → 永不联网（即便 tier=expand）",
  decideWeb({ isTaskQuery: true, modelUseWeb: true, planFellBack: false, heuristicWeb: true, tier: "expand" }) === false
);
check(
  "模型显式 useWeb=true → 联网（即便 precise）",
  decideWeb({ isTaskQuery: false, modelUseWeb: true, planFellBack: false, heuristicWeb: false, tier: "precise" }) === true
);
check(
  "回退路径 + 启发式命中 + precise → 联网（缺陷B 修复：喂真 tier 的启发式仍可触发）",
  decideWeb({ isTaskQuery: false, modelUseWeb: false, planFellBack: true, heuristicWeb: true, tier: "precise" }) === true
);
check(
  "回退路径 + 启发式不命中 + precise → 不联网",
  decideWeb({ isTaskQuery: false, modelUseWeb: false, planFellBack: true, heuristicWeb: false, tier: "precise" }) === false
);
check(
  "KB 未跑(空 tier) + 模型 useWeb=false + 非回退 → 不联网",
  decideWeb({ isTaskQuery: false, modelUseWeb: false, planFellBack: false, heuristicWeb: false, tier: "" }) === false
);

console.log("\n" + "=".repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(64));
process.exit(fail === 0 ? 0 : 1);
