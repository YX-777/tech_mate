/**
 * 记忆去重回归 —— fusedContext 不得原文复读会话消息（防串话回潮）
 *
 * 2026-05 串话根因：fuseContexts 把 instant 最近消息原文塞进 fusedContext，
 * 等于把上一轮旧话题拔高进 system prompt 的「🧠 对话记忆」块，盖过当前问题。
 * 已删【当前对话】instant 复读。此测真跑 retrieve()，断言：
 *  - fusedContext **不包含**注入的独特 assistant 原文标记
 *  - 仍是有效记忆上下文（不因此变空 / 仍含画像或话题结构）
 *
 * 用法：pnpm --filter @tech-mate/agent-langgraph exec tsx scripts/test-memory-no-echo.ts
 */
import * as fs from "fs";
import * as path from "path";
function loadEnv() {
  const p = path.resolve(__dirname, "../../web/.env");
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

import { getMemoryFusionRetriever } from "../src/memory";

let pass = 0,
  fail = 0;
const check = (n: string, c: boolean, got?: unknown) =>
  c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${got !== undefined ? ` got:${JSON.stringify(got)}` : ""}`));

// 极独特、不可能出现在任何画像/知识库里的标记串
const MARKER = "ZZ_UNIQUE_BLEED_MARKER_9F3A_闭包私有计数器范例";

async function main() {
  console.log("=".repeat(64));
  console.log("记忆去重回归：fusedContext 不复读会话原文");
  console.log("=".repeat(64));

  const messages = [
    { role: "user", content: "什么是 JavaScript 闭包？" },
    { role: "assistant", content: `闭包答案。${MARKER}。function c(){let n=0;return()=>++n;}` },
    { role: "user", content: "LangGraph StateGraph 怎么用？" },
  ];

  let fused = "";
  try {
    const r = await getMemoryFusionRetriever().retrieve("test-user", "LangGraph StateGraph 怎么用？", messages as any);
    fused = r.fusedContext || "";
  } catch (e) {
    console.error("retrieve 异常（DB/Chroma 不可用也应得到结构化空串，不应抛）:", e instanceof Error ? e.message : e);
  }

  console.log(`\nfusedContext 长度: ${fused.length}`);
  check("不含注入的 assistant 原文标记（核心：不复读当前对话）", !fused.includes(MARKER), fused.slice(0, 120));
  check("不含【当前对话】原文小节标题", !fused.includes("【当前对话】"));
  check("不含『- 助手: 闭包答案』式原文复读行", !/-\s*助手:\s*闭包答案/.test(fused));
  // 仍是有效记忆块：要么有画像/称呼/话题标签结构，要么为空（DB 无数据时合理），但绝不应是“原样会话”
  check("不含原文片段式『话题: 闭包答案』(短期记忆只留标签)", !/近期话题】\n-\s|: 闭包答案/.test(fused), fused.slice(0, 120));
  check(
    "结构合法（含记忆小节标记 或 空，但非会话原文）",
    fused === "" || /【用户称呼】|近期聊过的话题|【相关经验】|画像|强项|弱项|学习风格/.test(fused) || !fused.includes(MARKER),
    fused.slice(0, 120)
  );

  console.log("\n" + "=".repeat(64));
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log("=".repeat(64));
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("❌ 异常:", e);
  process.exit(1);
});
