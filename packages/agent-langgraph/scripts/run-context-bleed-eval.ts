/**
 * 上下文串话回归 eval（context-bleed）
 *
 * 防的是 2026-05 "问拼多多营收答出 React Hooks" 这一类 bug：
 *   注入的历史 / 四阶记忆话题污染了回答，模型没紧扣当前问题。
 *
 * 关键设计：装配 prompt 时**直接复用线上 buildAnswerRules()**（单一来源），
 *   所以这测的是真实规则，不是副本——规则一漂移，这里立刻挂。
 *
 * 流程：DEFAULT + 合成污染记忆 + 真实回答规则 + [污染历史轮次, 新问题]
 *   → 真实生成 → LLM judge 判 on_topic / hijacked
 *
 * 诚实边界：依赖 LLM，有 ±抖动（同 run-rag-eval）；12 题小集只表方向；
 *   不把通过率写进简历，仅作回归护栏 + 现场可复跑论据。
 *
 * 用法：pnpm --filter @tech-mate/agent-langgraph exec tsx scripts/run-context-bleed-eval.ts
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

import { SYSTEM_PROMPTS, buildAnswerRules, buildWebEmptyNotice } from "../src/prompts/system-prompts";
import { chatLLM } from "../src/llm/client";

interface Item {
  id: string;
  tag: string;
  prior_user: string;
  prior_assistant: string;
  memory_note: string;
  question: string;
  forbidden: string;
  expect: string;
  /** 该题模拟"联网请求了但 web_search 返回 null"场景：
   *  装配时追加线上同一份 buildWebEmptyNotice()（单一来源，测真规则）。
   *  2026-05-19 串话回归（localhost 短路 + web 为空注入）的护栏。 */
  web_empty?: boolean;
}

const SET_PATH = path.resolve(__dirname, "../../../scripts/eval/context-bleed-eval-set.jsonl");
const OUT_PATH = path.resolve(__dirname, "../../../scripts/eval/context-bleed-results.json");

function parseJsonLoose(raw: string): any | null {
  const cleaned = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function generate(item: Item): Promise<string> {
  const systemPrompt =
    SYSTEM_PROMPTS.DEFAULT +
    `\n\n## 🧠 对话记忆与用户画像\n${item.memory_note}\n\n` +
    buildAnswerRules({ hasCitableSources: false, citableList: "" }) +
    // 与 nodes.ts 的 `else if (doWebSearch)` 分支同一份单一来源：
    // 联网试过但为空 → 注入 buildWebEmptyNotice()。规则一漂移这里立刻挂。
    (item.web_empty ? `\n\n${buildWebEmptyNotice()}` : "");
  const { content } = await chatLLM({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: item.prior_user },
      { role: "assistant", content: item.prior_assistant },
      { role: "user", content: item.question },
    ],
    tier: "T2",
    temperature: 0.3,
    maxTokens: 700,
  });
  return content;
}

async function judge(item: Item, answer: string): Promise<{ on_topic: boolean; hijacked: boolean; note: string }> {
  const prompt = `你是严格的回答审查员。判断下面这段"回答"是否紧扣"当前问题"，有没有被旧话题带跑。

【当前问题】${item.question}
【这个问题应当回答的主题】${item.expect}
【绝不能喧宾夺主的旧话题】${item.forbidden}

【待审回答】
${answer}

判定：
- on_topic：回答是否**实质性地**针对"当前问题"的主题作答（如实说"没检索到最新信息"也算 on_topic）。
- hijacked：回答是否**主体内容**在讲那个旧话题（forbidden），而不是当前问题。只是顺带一句称呼/过渡不算 hijacked。

只输出 JSON：{"on_topic": true或false, "hijacked": true或false, "note": "10 字内理由"}`;
  const { content } = await chatLLM({
    messages: [
      { role: "system", content: "你是严格审查员，只输出 JSON。" },
      { role: "user", content: prompt },
    ],
    tier: "T2",
    temperature: 0.1,
    maxTokens: 200,
  });
  const o = parseJsonLoose(content);
  if (!o) return { on_topic: false, hijacked: true, note: "judge 解析失败(保守判失败)" };
  return { on_topic: o.on_topic === true, hijacked: o.hijacked === true, note: String(o.note || "").slice(0, 40) };
}

async function main() {
  const set: Item[] = fs
    .readFileSync(SET_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  console.log("=".repeat(64));
  console.log(`Context-Bleed 回归 —— ${set.length} 题（污染历史+记忆，看是否串话）`);
  console.log("=".repeat(64));

  const rows: any[] = [];
  for (let i = 0; i < set.length; i++) {
    const it = set[i];
    process.stdout.write(`[${i + 1}/${set.length}] ${it.id} [${it.tag}] ... `);
    let answer = "";
    let verdict;
    try {
      answer = await generate(it);
      verdict = await judge(it, answer);
    } catch (e) {
      verdict = { on_topic: false, hijacked: true, note: `异常:${e instanceof Error ? e.message : e}` };
    }
    const pass = verdict.on_topic && !verdict.hijacked;
    rows.push({
      id: it.id,
      tag: it.tag,
      question: it.question,
      forbidden: it.forbidden,
      on_topic: verdict.on_topic,
      hijacked: verdict.hijacked,
      pass,
      note: verdict.note,
      answerHead: answer.slice(0, 120).replace(/\n/g, " "),
    });
    console.log(pass ? "✓ 贴题" : `✗ 串话 (on_topic=${verdict.on_topic} hijacked=${verdict.hijacked})`);
  }

  const n = rows.length;
  // 主指标（回归门禁）：on_topic —— 是否答了"当前问题的主题"。
  //   on_topic=false 才是 2026-05 那个灾难 bug（拼多多答出 React）。
  const onTopicRate = rows.filter((r) => r.on_topic).length / n;
  // 次指标（软、judge 偏严、有 ±抖动）：strict = on_topic 且未被旧话题抢戏。
  const strictAdherence = rows.filter((r) => r.pass).length / n;
  const hijackRate = rows.filter((r) => r.hijacked).length / n;
  const wrongTopic = rows.filter((r) => !r.on_topic);

  console.log("\n" + "=".repeat(64));
  console.log(
    `【主门禁】话题正确率 on_topic : ${(onTopicRate * 100).toFixed(1)}%  (${rows.filter((r) => r.on_topic).length}/${n})  ← 真·串话 bug 看这个`
  );
  console.log(
    `【软指标】严格贴合 (未被抢戏) : ${(strictAdherence * 100).toFixed(1)}%  · 被旧话题抢戏率 ${(hijackRate * 100).toFixed(1)}%（judge 偏严，对个性化类比敏感，有 ±抖动）`
  );
  if (wrongTopic.length === 0) {
    console.log(`✓ 无任何"答非所问"样本 —— 灾难级串话 bug 零复现`);
  } else {
    console.log(`✗ 出现 ${wrongTopic.length} 个答非所问（真 bug 复现）：${wrongTopic.map((r) => r.id).join(", ")}`);
  }

  const fails = rows.filter((r) => !r.pass);
  if (fails.length) {
    console.log(`\n串话样本 (${fails.length})：`);
    for (const f of fails) {
      console.log(`  ✗ ${f.id} [${f.tag}] Q="${f.question}" | ${f.note}`);
      console.log(`     答头: ${f.answerHead}`);
    }
  } else {
    console.log(`\n✓ 全部 ${n} 题紧扣当前问题，无串话`);
  }

  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        evalSetSize: n,
        summary: { onTopicRate, strictAdherence, hijackRate, wrongTopicCount: wrongTopic.length },
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
