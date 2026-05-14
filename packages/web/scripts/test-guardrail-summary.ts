/**
 * GuardRail 统一三态 —— 确定性回归（无 LLM、可现场复跑、纳入版本控制）
 *
 * 锁死本次"重新梳理历史遗留"的核心修复点，防再退化：
 *  - SSRF 输入短路 → input=block（请求是被拦的，不能再显示"已通过防护"）
 *  - 本次没调工具 → tool=skip（**绝不再伪装成 ✅通过**，这是核心诚实叙事）
 *  - L3 无来源可对照 → output=skip（旧的 applied 特例收编进统一模型）
 *  - 旧消息 legacy 结构 → 诚实降级，未知状态不伪绿
 *
 * 用法：pnpm --filter @tech-mate/web exec tsx scripts/test-guardrail-summary.ts
 */
import { buildGuardrailSummary, normalizeGuard } from "../src/lib/guardrail-summary";

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
console.log("GuardRail 统一三态回归");
console.log("=".repeat(64));

// 1. 服务器实测场景：SSRF 输入短路（localhost）→ input=block / tool=skip / output=skip
{
  const r = buildGuardrailSummary({
    inputBlock: { reason: "SSRF / 内网访问", maxRisk: "high" },
    l1: { hitCount: 0, maxRisk: "low", action: "allow" },
    l2: { ran: false, blocks: [] },
    l3: { applied: false, passed: true, hitCount: 0 },
  });
  console.log("\n[1] SSRF 输入短路（服务器实测复刻）");
  check("input=block", r.input.state === "block", r.input.state);
  check("tool=skip（未调工具，不伪绿）", r.tool.state === "skip", r.tool.state);
  check("output=skip（无来源可校验）", r.output.state === "skip", r.output.state);
}

// 2. 正常联网成功回答 → 三层都 pass
{
  const r = buildGuardrailSummary({
    inputBlock: null,
    l1: { hitCount: 0, maxRisk: "low", action: "allow" },
    l2: { ran: true, blocks: [] },
    l3: { applied: true, passed: true, hitCount: 0, similarity: 0.82 },
  });
  console.log("\n[2] 正常联网成功");
  check("input=pass", r.input.state === "pass", r.input.state);
  check("tool=pass（工具真跑过且通过）", r.tool.state === "pass", r.tool.state);
  check("output=pass", r.output.state === "pass", r.output.state);
}

// 3. 纯本地知识库回答、没调任何工具 → tool 必须 skip，不能伪绿（核心 bug）
{
  const r = buildGuardrailSummary({
    inputBlock: null,
    l1: { hitCount: 0 },
    l2: { ran: false, blocks: [] },
    l3: { applied: true, passed: true, hitCount: 0 },
  });
  console.log("\n[3] 无工具调用（L2 伪绿 bug 回归点）");
  check("tool=skip 而非 pass", r.tool.state === "skip", r.tool.state);
}

// 4. L2 真拦截了工具调用（如 web_search 改写后命中 SSRF）→ tool=block
{
  const r = buildGuardrailSummary({
    inputBlock: null,
    l1: { hitCount: 0 },
    l2: { ran: true, blocks: [{ tool: "web_search", maxRisk: "high", hits: [{ reason: "疑似 SSRF" }] }] },
    l3: { applied: false, passed: true, hitCount: 0 },
  });
  console.log("\n[4] L2 拦截工具调用");
  check("tool=block", r.tool.state === "block", r.tool.state);
  check("output=skip（被拦无输出可校验）", r.output.state === "skip", r.output.state);
}

// 5. L1 命中但脱敏继续 → input=warn（非 block 非 pass）
{
  const r = buildGuardrailSummary({
    inputBlock: null,
    l1: { hitCount: 2, maxRisk: "medium", action: "sanitize" },
    l2: { ran: true, blocks: [] },
    l3: { applied: true, passed: true, hitCount: 0 },
  });
  console.log("\n[5] L1 中风险脱敏");
  check("input=warn", r.input.state === "warn", r.input.state);
  check("detail 含脱敏说明", (r.input.detail || "").includes("脱敏"), r.input.detail);
}

// 6. L3 观测命中告警（不阻断）→ output=warn
{
  const r = buildGuardrailSummary({
    inputBlock: null,
    l1: { hitCount: 0 },
    l2: { ran: true, blocks: [] },
    l3: { applied: true, passed: false, hitCount: 1, similarity: 0.05 },
  });
  console.log("\n[6] L3 观测告警");
  check("output=warn（标注不阻断）", r.output.state === "warn", r.output.state);
}

// 7. legacy 旧消息适配：老结构 → 诚实降级
{
  const legacy = {
    input: { passed: true, hits: 0, maxRisk: "low" },
    tool: { count: 0, blocks: [] },
    output: { passed: true, hits: 0, applied: false },
  };
  const r = normalizeGuard(legacy);
  console.log("\n[7] legacy 旧消息适配");
  check("input=pass", r.input.state === "pass", r.input.state);
  check("tool=skip（旧数据无法回溯，不伪绿）", r.tool.state === "skip", r.tool.state);
  check("output=skip（applied=false）", r.output.state === "skip", r.output.state);
}

// 8. legacy 老结构里 tool 被拦过 → block；新结构透传不变
{
  const r1 = normalizeGuard({
    input: { passed: false, hits: 1, maxRisk: "high" },
    tool: { count: 1, blocks: [{ tool: "web_search", maxRisk: "high", hits: [] }] },
    output: { passed: true, hits: 0 },
  });
  const already = buildGuardrailSummary({
    inputBlock: { reason: "SSRF / 内网访问" },
    l1: { hitCount: 0 },
    l2: { ran: false, blocks: [] },
    l3: { applied: false, passed: true, hitCount: 0 },
  });
  const r2 = normalizeGuard(already);
  console.log("\n[8] legacy tool 拦截 + 新结构透传");
  check("legacy input=warn", r1.input.state === "warn", r1.input.state);
  check("legacy tool=block", r1.tool.state === "block", r1.tool.state);
  check("新结构原样返回（已是 state 模型）", r2.input.state === "block", r2.input.state);
}

console.log("\n" + "=".repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(64));
process.exit(fail === 0 ? 0 : 1);
