/**
 * 记忆节点 Trace 可回溯 —— 确定性自测（无 LLM）
 *
 * 锁死：四阶记忆融合在 OTel trace 里产生
 *   memory.fusion(父) + memory.instant/short/long/meta(4 子) 共 5 个 span，
 *   状态 success，父 span 带四层条数 + parallelMs 属性。
 * 跑真实 fusion.retrieve()；DB/Chroma 不可用时各 getter 自带 try/catch 降级为空，
 * 不影响 span 产出（本测只验"可回溯"这件事本身，不验记忆内容）。
 *
 * 用法：pnpm --filter @tech-mate/agent-langgraph exec tsx scripts/test-memory-trace.ts
 */
import * as fs from "fs";
import * as path from "path";

function loadEnv() {
  const envPath = path.resolve(__dirname, "../../web/.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

import { createTraceContext, runInTrace } from "../src/otel";
import { getMemoryFusionRetriever } from "../src/memory";

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

async function main() {
  console.log("=".repeat(64));
  console.log("记忆节点 Trace 可回溯 回归");
  console.log("=".repeat(64));

  const trace = createTraceContext("test-user", "test-conv");
  await runInTrace(trace, async () =>
    getMemoryFusionRetriever().retrieve(
      "test-user",
      "什么是 JavaScript 闭包？",
      [{ role: "user", content: "什么是 JavaScript 闭包？" }]
    )
  );

  const byName = new Map(trace.allSpans.map((s) => [s.name, s]));
  const expected = [
    "memory.fusion",
    "memory.instant",
    "memory.short",
    "memory.long",
    "memory.meta",
  ];

  console.log("\n[1] 5 个记忆 span 都进了 trace");
  for (const n of expected) {
    check(`存在 span ${n}`, byName.has(n), Array.from(byName.keys()));
  }

  console.log("\n[2] span 状态 success（getter 内部降级不应让 span 失败）");
  for (const n of expected) {
    const sp = byName.get(n);
    check(`${n} status=success`, sp?.status === "success", sp?.status);
  }

  console.log("\n[3] 父 span memory.fusion 带四层可回溯属性");
  const fusion = byName.get("memory.fusion");
  const a = fusion?.attributes || {};
  check("含 instant 计数", typeof a.instant === "number", a);
  check("含 short 计数", typeof a.short === "number", a);
  check("含 long 计数", typeof a.long === "number", a);
  check("含 fusedLength", typeof a.fusedLength === "number", a);
  check("含 parallelMs（四路并行耗时，瀑布图据此回溯瓶颈）", typeof a.parallelMs === "number", a);

  console.log("\n[4] 子 span 各自带分层属性");
  check("memory.instant 有 messages 属性", typeof byName.get("memory.instant")?.attributes?.messages === "number");
  check("memory.meta 有 learningStyle 属性", "learningStyle" in (byName.get("memory.meta")?.attributes || {}));

  console.log("\n" + "=".repeat(64));
  console.log(`结果：${pass} 通过 / ${fail} 失败 · trace 共 ${trace.allSpans.length} 个 span`);
  console.log("=".repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n❌ 自测异常:", e);
  process.exit(1);
});
