/**
 * 模块复习推荐 —— 确定性回归（无 LLM / 无 DB，纯函数 + 固定日期）
 *
 * 锁死：
 *  - 遗忘曲线复用 short.ts ebbinghausRetention 同一函数（不是两套数学）
 *  - accuracy 调制半衰期：同样 8 天没练，薄弱模块被推、掌握好的不推
 *  - 没练过(lastPracticedAt 空) / 未来时间 → 诚实跳过，不臆造
 *  - 按预测保持度升序（最该复习的在前），阈值/上限生效
 *
 * 用法：pnpm --filter @tech-mate/agent-langgraph exec tsx scripts/test-review-recommender.ts
 */
import { ebbinghausRetention } from "../src/memory/short";
import {
  scoreModulesForReview,
  halfLifeForAccuracy,
  formatReviewBlock,
} from "../src/memory/review-recommender";

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

const DAY = 86_400_000;
const NOW = new Date("2026-05-19T00:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

console.log("=".repeat(64));
console.log("模块复习推荐 回归");
console.log("=".repeat(64));

console.log("\n[1] 遗忘曲线 ebbinghausRetention（与短期记忆同一函数）");
check("days=0 → 1.0", ebbinghausRetention(0, 7) === 1);
check("days=半衰期 → 0.5", ebbinghausRetention(7, 7) === 0.5);
check("days=2×半衰期 → 0.25", ebbinghausRetention(14, 7) === 0.25);
check("半衰期<=0 → 0（防护）", ebbinghausRetention(5, 0) === 0);

console.log("\n[2] accuracy 调制半衰期（掌握越好记越久）");
check("accuracy 0 → 0.5×base(3.5)", halfLifeForAccuracy(0, 7) === 3.5);
check("accuracy 50 → 1.0×base(7)", halfLifeForAccuracy(50, 7) === 7);
check("accuracy 100 → 1.5×base(10.5)", halfLifeForAccuracy(100, 7) === 10.5);

console.log("\n[3] 同样 8 天没练：薄弱被推、掌握好的不推（调制生效的核心证据）");
const items = scoreModulesForReview(
  [
    { moduleName: "M_never", accuracy: 50, lastPracticedAt: null },
    { moduleName: "M_strong", accuracy: 90, lastPracticedAt: ago(8) },
    { moduleName: "M_weak", accuracy: 20, lastPracticedAt: ago(8) },
    { moduleName: "M_stale", accuracy: 60, lastPracticedAt: ago(30) },
    { moduleName: "M_fresh", accuracy: 70, lastPracticedAt: ago(1) },
    { moduleName: "M_future", accuracy: 50, lastPracticedAt: ago(-2) },
  ],
  NOW
);
const names = items.map((i) => i.moduleName);
check("M_never(没练过)被跳过", !names.includes("M_never"), names);
check("M_future(未来时间)被跳过", !names.includes("M_future"), names);
check("M_strong(90分,8天)不推", !names.includes("M_strong"), names);
check("M_fresh(1天前)不推", !names.includes("M_fresh"), names);
check("M_weak(20分,8天)被推", names.includes("M_weak"), names);
check("M_stale(30天没练)被推", names.includes("M_stale"), names);
check("排序：最该复习(保持度最低)的 M_stale 在最前", names[0] === "M_stale", names);
check(
  "保持度升序",
  items.every((it, idx) => idx === 0 || items[idx - 1].retention <= it.retention),
  items.map((i) => i.retention)
);
const weak = items.find((i) => i.moduleName === "M_weak")!;
check("M_weak retention < 0.5 阈值", weak.retention < 0.5, weak.retention);
check("reason 含天数与保持度文案", /天没练，预测保持度 \d+%/.test(weak.reason), weak.reason);

console.log("\n[4] 阈值 / 上限可调");
const capped = scoreModulesForReview(
  [
    { moduleName: "A", accuracy: 10, lastPracticedAt: ago(40) },
    { moduleName: "B", accuracy: 10, lastPracticedAt: ago(35) },
    { moduleName: "C", accuracy: 10, lastPracticedAt: ago(30) },
    { moduleName: "D", accuracy: 10, lastPracticedAt: ago(25) },
  ],
  NOW,
  { max: 2 }
);
check("max=2 截断", capped.length === 2, capped.length);
check("截断后仍是最该复习的两个(A,B)", capped.map((i) => i.moduleName).join(",") === "A,B", capped.map((i) => i.moduleName));

console.log("\n[5] formatReviewBlock");
check("空列表 → 空串", formatReviewBlock([]) === "");
const block = formatReviewBlock(items);
check("非空含艾宾浩斯标题", block.includes("艾宾浩斯遗忘曲线"), block);
check("非空含模块名", block.includes("M_stale"), block);

console.log("\n" + "=".repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(64));
process.exit(fail === 0 ? 0 : 1);
