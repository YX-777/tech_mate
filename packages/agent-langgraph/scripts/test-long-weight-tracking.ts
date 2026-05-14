/**
 * 长期记忆追踪评分 —— 确定性回归（无 LLM / 无 DB，纯权重数学）
 *
 * 锁死"追踪评分"的核心数学（reinforceWeight 内部、search() 命中强化都用它）：
 *  - 单次命中 +RETRIEVAL_BOOST，封顶 1.0 不溢出
 *  - 多次命中单调递增、渐进逼近并停在 1.0（越常召回越重要、不无限涨）
 *  - 步长是小步（渐进追踪，不是一次跳满）
 *
 * 用法：pnpm --filter @tech-mate/agent-langgraph exec tsx scripts/test-long-weight-tracking.ts
 */
import { nextWeight, RETRIEVAL_BOOST } from "../src/memory/long";

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
console.log("长期记忆追踪评分 回归");
console.log("=".repeat(64));

console.log("\n[1] nextWeight 单次强化");
check("0.50 +0.05 → 0.55", nextWeight(0.5, 0.05) === 0.55, nextWeight(0.5, 0.05));
check("0.98 +0.05 → 1.0（封顶不溢出）", nextWeight(0.98, 0.05) === 1.0, nextWeight(0.98, 0.05));
check("1.0 +0.05 → 1.0（饱和保持）", nextWeight(1.0, 0.05) === 1.0, nextWeight(1.0, 0.05));
check("undefined → 按 0.5 起算 → 0.55", nextWeight(undefined, 0.05) === 0.55, nextWeight(undefined, 0.05));
check("+0 → 不变", nextWeight(0.5, 0) === 0.5, nextWeight(0.5, 0));

console.log("\n[2] RETRIEVAL_BOOST 是小步长（渐进追踪，非一次跳满）");
check("0 < BOOST <= 0.2", RETRIEVAL_BOOST > 0 && RETRIEVAL_BOOST <= 0.2, RETRIEVAL_BOOST);

console.log("\n[3] 多次命中：单调递增、收敛到 1.0、永不超");
let w = 0.6;
const path: number[] = [w];
let monotonic = true;
for (let i = 0; i < 20; i++) {
  const nw = nextWeight(w, RETRIEVAL_BOOST);
  if (nw < w) monotonic = false; // 绝不下降
  if (nw > 1.0) monotonic = false; // 绝不超 1.0
  w = nw;
  path.push(Number(w.toFixed(4)));
}
check("全程单调不降且 ≤ 1.0", monotonic, path);
check("多次命中后收敛到 1.0", w === 1.0, w);
const steps = path.findIndex((x) => x >= 1.0);
check("从 0.6 起渐进(>1 步)才到顶，不是一次跳满", steps > 1, steps);

console.log("\n[4] 不同起点都收敛到 1.0（被频繁召回 = 最重要）");
for (const start of [0.65, 0.7, 0.9]) {
  let v = start;
  for (let i = 0; i < 30; i++) v = nextWeight(v, RETRIEVAL_BOOST);
  check(`起点 ${start} 多次命中后 → 1.0`, v === 1.0, v);
}

console.log("\n" + "=".repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(64));
process.exit(fail === 0 ? 0 : 1);
