/**
 * 节点定义
 * LangGraph 状态机的各个节点
 */

import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { logger, QuickReplyOption } from "@tech-mate/core";
import type { UserIntent } from "@tech-mate/core";
import { getChatModel, startStreamLLM, resolveTierConfig, type LLMTier, type RoutingHint } from "../llm";
import { SYSTEM_PROMPTS, buildAnswerRules, buildWebEmptyNotice } from "../prompts/system-prompts";
import { TASK_PROMPTS } from "../prompts/task-prompts";
import { getMCPToolClient } from "../tools/mcp-tools";
import { TimeTools, StringTools, ProgressTools, LogTools } from "../tools/local-tools";
import { getEmotionDetector } from "../middleware/emotion-detector";
import { getContextEnhancer } from "../middleware/context-enhancer";
import { getAgentConfig } from "../config/agent.config";
import type { GraphStateType } from "./state";
import { retrieveWithFallback } from "../utils/rag-fallback";
import { planRetrieval } from "./retrieval-planner";
import { isKbConfident, decideWeb } from "./retrieval-decision";
import { shouldUseWebSearch, webSearch, type WebSearchResult } from "../tools/web-search";
import { SSRF_INTERNAL_PATTERN } from "../guardrail";
import { logAgentEvent } from "../utils/event-logger";
import { getCurrentTrace } from "../otel/async-context";
import {
  buildGeneralAnswerPrompt,
  resolveXiaohongshuKnowledge,
  shouldRouteToXiaohongshuRag,
} from "./xiaohongshu-rag";
import { parseTaskPlanFromText } from "./task-plan";
import { getMemoryFusionRetriever, type Message } from "../memory";
import { getUserRepository, getTaskService } from "@tech-mate/database";

/**
 * 从用户消息中抽取姓名（正则方式，覆盖最常见的几种中文表达）
 *
 * 命中后回写到 UserProfile.nickname，下次任何会话的 memoryContextPrompt
 * 都会带上"用户称呼"字段。
 *
 * 设计：保守命中而不是大而全。常见 false positive 用排除清单兜底。
 */
const NICKNAME_BLOCKLIST = new Set([
  // 代词
  "我", "你", "他", "她", "它", "您",
  // 疑问代词 —— "我叫什么" 会被误抽成"什么"
  "什么", "啥", "谁", "哪个", "哪位", "几", "多少", "啥子", "什麼",
  // 角色泛称
  "学生", "学习者", "用户", "小白", "新手", "老手",
  "技术", "前端", "后端", "全栈", "工程师", "程序员", "开发者",
  // 客套词
  "好的", "可以", "知道", "明白", "对", "是", "不是",
]);

/**
 * 判断是否是疑问句（问句不该抽姓名，比如"我叫什么"、"我是谁"）
 */
function isInterrogative(text: string): boolean {
  if (!text) return false;
  // 句末问号（中英文）
  if (/[?？]\s*$/.test(text)) return true;
  // 显式疑问代词出现在自报句式中
  if (/我叫\s*(?:什么|啥|谁|哪个)/.test(text)) return true;
  if (/我是\s*(?:谁|哪位|哪个)/.test(text)) return true;
  if (/我的名字(?:是|叫)\s*(?:什么|啥|哪个)/.test(text)) return true;
  // "吗 / 呢"语气词结尾
  if (/(?:吗|呢)\s*[?？]?\s*$/.test(text)) return true;
  return false;
}

export function extractNickname(text: string): string | null {
  if (!text) return null;
  // 疑问句整体跳过 —— 避免"我叫什么"被抽成"什么"
  if (isInterrogative(text)) return null;
  // 中文常见自报姓名表达
  const patterns: RegExp[] = [
    /我叫([一-龥A-Za-z]{1,8})/,
    /我的名字(?:是|叫)([一-龥A-Za-z]{1,8})/,
    /我是([一-龥A-Za-z]{1,8})(?:[，。,.!?！？]|$)/,
    /叫我([一-龥A-Za-z]{1,8})/,
    /[Mm]y name is\s+([A-Za-z]{2,12})/,
    /[Ii]'?m\s+([A-Za-z]{2,12})(?:[\s,.!?]|$)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const name = m[1].trim();
    if (NICKNAME_BLOCKLIST.has(name)) continue;
    // 兜底：抽出的"姓名"中如果包含任何黑名单词（如"什么名字"含"什么"），也跳过
    let polluted = false;
    for (const bad of NICKNAME_BLOCKLIST) {
      if (bad.length >= 2 && name.includes(bad)) { polluted = true; break; }
    }
    if (polluted) continue;
    if (name.length < 1 || name.length > 12) continue;
    return name;
  }
  return null;
}

/**
 * 检测并持久化用户姓名（异步，失败不阻塞主流程）
 */
async function detectAndSaveNickname(userId: string, content: string): Promise<string | null> {
  const name = extractNickname(content);
  if (!name) return null;

  try {
    const userRepo = getUserRepository();
    // 确保 User + UserProfile 已存在
    await userRepo.findOrCreateUser(userId);
    const profile = await userRepo.getUserProfile(userId);
    // 已有非默认昵称且不一致时也覆盖（用户重新自报）
    if (profile?.nickname === name) {
      return name;
    }
    await userRepo.updateUserProfile(userId, { nickname: name });
    console.log(`👤 [Identity] 用户姓名已更新：${profile?.nickname || "未设置"} → ${name}`);
    return name;
  } catch (e) {
    console.warn("[Identity] 写入 nickname 失败：", e);
    return null;
  }
}

/**
 * 流式调用 LLM（带思考过程）
 * 走 llm/client.ts 的 startStreamLLM，按 tier 路由具体模型 + 端点
 */
export type StreamChunkType = "thought" | "content" | "step";

export interface StreamChunk {
  type: StreamChunkType;
  text: string;
  // step 专用字段
  stepId?: string;
  stepLabel?: string;
  stepIcon?: string;
  stepStatus?: "running" | "done" | "skip";
  stepDetail?: string;
}

/**
 * 过滤思考标签
 * Qwen3 enable_thinking 开启后，content 可能仍包含思考标签
 * 此函数过滤掉这些标签，只保留纯答案内容
 */
function filterThinkingTags(text: string): string {
  if (!text) return "";

  let filtered = text;

  // 过滤 Qwen3 思考标签（特殊字符格式）
  // 标签格式：темы...\/темы
  // 直接使用正则匹配
  filtered = filtered.replace(/темы[\s\S]*?темы/gi, "");

  // 过滤其他常见的思考分隔符格式
  filtered = filtered.replace(/<\|thought\|>/gi, "");
  filtered = filtered.replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, "");

  // 清理多余的空行
  filtered = filtered.replace(/\n{3,}/g, "\n\n");

  return filtered.trim();
}

/**
 * 智能快捷回复 — 按本次回答用到的来源生成相关引导问题
 *
 * 设计理念：固定 "继续提问/深入话题/换个话题" 太空泛，根据真实场景给精准引导：
 * - 用了本地 KB → "举个代码例子" / "和其他方案对比" / "深入原理"
 * - 用了 web 搜索 → "看看最新动态" / "查官方文档" / "换个角度搜"
 * - 都没用上 → 引导用户提供更具体场景
 */
export function buildSmartQuickReplies(opts: {
  hasKB: boolean;
  hasWeb: boolean;
  query: string;
}): string[] {
  if (opts.hasKB && opts.hasWeb) {
    return ["举个代码例子", "对比其他方案", "看官方文档"];
  }
  if (opts.hasKB) {
    return ["举个代码例子", "深入原理", "和实战结合"];
  }
  if (opts.hasWeb) {
    return ["看看最新动态", "找官方文档", "换个角度问"];
  }
  // 纯闲聊/记忆类
  return ["给我推荐学习方向", "我想学 React", "我想学 AI/Agent"];
}

/**
 * 用轻量 LLM 根据当前问答生成相关追问
 *
 * 设计：用 qwen-turbo 控制延迟（300-600ms），失败时回落到 buildSmartQuickReplies。
 * 这里调用的轻量模型与意图识别共用，复用 createLightLLM。
 */
async function generateContextualQuickReplies(
  query: string,
  answer: string,
  fallback: string[]
): Promise<string[]> {
  try {
    // 答案太短就用 fallback（没有上下文价值）
    if (!answer || answer.length < 40) return fallback;

    const prompt = `用户刚问了：${query}

助手刚回答了（摘要）：${answer.slice(0, 500)}

请基于这次问答，提出 3 个用户最可能想接着问的相关问题。

要求：
- 每个问题 ≤ 14 个汉字
- 必须与刚才回答的具体技术点强相关（出现回答里的关键词），不要泛泛
- 三个问题角度不要重复（一个深入原理 / 一个实战代码 / 一个对比扩展）
- 严格输出 JSON 数组（不要 markdown 包裹、不要解释）：["问题1","问题2","问题3"]`;

    const llm = createLightLLM();
    const response = await llm.invoke([new HumanMessage(prompt)]);
    const raw = (response.content as string).trim();
    // 剥可能的 ```json 包裹
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return fallback;
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr) || arr.length === 0) return fallback;
    const result = arr.slice(0, 3).map(String).map(s => s.trim()).filter(s => s.length > 0 && s.length <= 20);
    return result.length > 0 ? result : fallback;
  } catch (e) {
    console.warn("[QuickReplies] 动态生成失败，回退固定模板：", e);
    return fallback;
  }
}

export async function* streamDashscopeAPIWithThinking(
  systemPrompt: string,
  userPrompt: string,
  options?: {
    history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    /** 路由提示：默认按 general_qa → T2 */
    hint?: RoutingHint;
    /** 强制指定 tier（覆盖 hint） */
    tier?: LLMTier;
  }
): AsyncGenerator<StreamChunk> {
  // 组装 messages：system + 历史对话 + 当前用户消息
  // 历史对话可让模型保持多轮上下文连贯（用户名字、上文提及的话题等）
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];
  if (options?.history?.length) {
    for (const m of options.history) {
      if (!m.content) continue;
      if (m.role === "system") continue; // system 由我们统一注入
      messages.push({ role: m.role, content: m.content });
    }
  }
  messages.push({ role: "user", content: userPrompt });

  // ========== 路由：hint/tier → 具体 model + endpoint + key ==========
  const { model, tier, reader } = await startStreamLLM({
    messages,
    hint: options?.hint ?? { task: "general_qa" },
    tier: options?.tier,
    // qwen3.6-plus 的 reasoning_content 是英文 self-talk，关掉直接出答案
    enableThinking: false,
  });

  // ========== OTel：LLM 调用 span（包含 first-byte/total token 计数）==========
  const trace = getCurrentTrace();
  const span = trace?.startSpan("llm.stream");
  span?.setAttributes({
    model,
    tier,
    systemPromptLen: systemPrompt.length,
    userPromptLen: userPrompt.length,
    historyLen: options?.history?.length ?? 0,
  });
  const llmStartedAt = Date.now();
  let firstByteAt: number | null = null;
  let spanChunkCount = 0;

  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      if (!line.startsWith("data: ")) continue;

      const dataStr = line.slice(6).trim();
      if (dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr) as any;
        const choice = parsed.choices?.[0];
        const delta = choice?.delta || choice?.message || {};

        chunkCount++;

        const thoughtText = delta?.reasoning_content || delta?.reasoning || "";
        let contentText = delta?.content || delta?.text || "";

        contentText = filterThinkingTags(contentText);

        if (thoughtText) {
          spanChunkCount++;
          if (firstByteAt === null) firstByteAt = Date.now();
          yield { type: "thought", text: thoughtText };
        }
        if (contentText) {
          spanChunkCount++;
          if (firstByteAt === null) firstByteAt = Date.now();
          yield { type: "content", text: contentText };
        }
      } catch {
        // 单条 SSE chunk 解析失败不影响整体流，忽略
      }
    }
  }

  // 结束 span 并记录关键性能指标（first byte / total ms / chunk 数）
  if (trace && span) {
    span.setAttributes({
      chunkCount: spanChunkCount,
      firstByteMs: firstByteAt ? firstByteAt - llmStartedAt : null,
      totalMs: Date.now() - llmStartedAt,
    });
    trace.endSpan(span, "success");
  }
}

/**
 * 流式调用 LLM（无思考过程，纯 content）
 * tier/hint 透传给底层 router，调用方可显式升档（如任务生成走 T3）
 */
async function* streamDashscopeAPI(
  systemPrompt: string,
  userPrompt: string,
  options?: { hint?: RoutingHint; tier?: LLMTier }
): AsyncGenerator<string> {
  for await (const chunk of streamDashscopeAPIWithThinking(systemPrompt, userPrompt, options)) {
    if (chunk.type === "content") {
      yield chunk.text;
    }
  }
}

/**
 * 主力 LLM —— T2（默认 qwen-plus）
 * 包装薄壳，所有非显式分流的 invoke 都走这里
 */
function createLLM(hint?: RoutingHint) {
  return getChatModel(hint ?? { task: "general_qa" });
}

/**
 * 创建快捷回复选项
 */
export function createQuickReplies(texts: string[]): QuickReplyOption[] {
  return texts.map((text) => ({
    id: `qr-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    text,
    action: text,
  }));
}

/**
 * 意图识别节点
 *
 * LLM 现在按 JSON 返回 { intent, reasoning, keywords }，
 * 三种映射兼容：
 * - 旧 prompt 返回纯意图字符串（容错）
 * - 新 prompt 返回 JSON 对象（标准路径）
 * - 部分模型把 JSON 包在 ```json ... ``` 里（剥壳）
 */
const INTENT_ALIASES: Record<string, UserIntent> = {
  general_qa: "general_inquiry",
  query_progress: "progress_tracking",
  emotion_support: "emotional_support",
  greeting: "general_inquiry", // 当前 graph 没有 greeting 节点，回落到通用
};

function normalizeIntent(raw: string): UserIntent {
  const v = (raw || "").trim().toLowerCase();
  if (INTENT_ALIASES[v]) return INTENT_ALIASES[v];
  // 直接匹配 UserIntent 枚举值
  const known: UserIntent[] = [
    "create_task", "update_task", "delete_task", "list_tasks",
    "search_knowledge", "study_material", "exam_simulation",
    "progress_tracking", "emotional_support", "general_inquiry",
  ];
  if (known.includes(v as UserIntent)) return v as UserIntent;
  return "general_inquiry";
}

function parseIntentResponse(text: string): {
  intent: UserIntent;
  reasoning: string;
  keywords: string[];
} {
  const fallback = { intent: "general_inquiry" as UserIntent, reasoning: "默认通用问答", keywords: [] as string[] };
  if (!text) return fallback;

  // 剥 ```json ... ``` 外壳
  let stripped = text.trim();
  stripped = stripped.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  // 找第一个 { ... } 块
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      return {
        intent: normalizeIntent(String(obj.intent || "")),
        reasoning: String(obj.reasoning || "").slice(0, 60),
        keywords: Array.isArray(obj.keywords) ? obj.keywords.slice(0, 3).map(String) : [],
      };
    } catch {
      // JSON 解析失败，往下走
    }
  }

  // 兜底：把整个文本当作意图名
  return {
    intent: normalizeIntent(stripped),
    reasoning: "LLM 未返回标准 JSON，按字符串解析",
    keywords: [],
  };
}

/**
 * 本地规则兜底：高置信度关键词命中直接返回，跳过 LLM
 *
 * 设计：保守命中、宁可漏判。命中要求"非常明显"，
 * 这样命中率不高但准确度极高；未命中再走 LLM 兜底。
 */
function ruleBasedIntent(content: string): {
  intent: UserIntent;
  reasoning: string;
  keywords: string[];
} | null {
  const text = content.trim();
  if (!text) return null;

  // 当前任务状态查询：优先级最高 —— 必须早于 planKeywords，否则"今天该做什么"
  // 会被 LLM 判成 create_task 触发追问。这类问题应该走 general_qa 用任务上下文回答。
  const taskQueryKeywords = [
    "今天该做什么", "今天做什么", "今天要做什么", "我今天该做", "我今天有",
    "今日任务", "今天的任务", "还有什么没做", "还剩什么", "我有什么任务", "我的任务",
  ];
  for (const kw of taskQueryKeywords) {
    if (text.includes(kw)) {
      return { intent: "general_inquiry", reasoning: "命中本地规则：当前任务状态查询", keywords: [kw] };
    }
  }

  // 学习计划相关（含"调整/重做"，让快捷回复也能命中）
  const planKeywords = [
    "学习计划", "学习路径", "学习路线", "制定计划", "规划学习", "怎么学",
    "调整任务", "调整计划", "重新规划", "改一下计划", "再来一份", "换一个计划",
  ];
  for (const kw of planKeywords) {
    if (text.includes(kw)) {
      return { intent: "create_task", reasoning: "命中本地规则：学习计划关键词", keywords: [kw] };
    }
  }

  // 进度查询
  const progressKeywords = ["学到哪", "学到什么程度", "我的进度", "学习进度", "学了多少"];
  for (const kw of progressKeywords) {
    if (text.includes(kw)) {
      return { intent: "progress_tracking", reasoning: "命中本地规则：进度查询关键词", keywords: [kw] };
    }
  }

  // 情绪支持（明显负面情绪）
  const emotionKeywords = ["压力大", "焦虑", "崩溃", "学不下去", "想放弃", "好累"];
  for (const kw of emotionKeywords) {
    if (text.includes(kw)) {
      return { intent: "emotional_support", reasoning: "命中本地规则：负面情绪关键词", keywords: [kw] };
    }
  }

  return null;
}

/**
 * 轻量 LLM —— T1（默认 qwen-turbo-latest，比主力快 3-5 倍）
 * 用于意图识别 / 快捷回复生成 / 事实抽取 等轻任务
 */
function createLightLLM() {
  return getChatModel(
    { task: "intent_classification" },
    { temperature: 0, maxTokens: 120 }
  );
}

export async function intentRecognitionNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  logger.info("Intent recognition node executing");

  const lastMessage = state.messages[state.messages.length - 1];
  const content = lastMessage.content as string;

  // Fast path 0：上一轮 task_generation 触发了追问（state.clarificationNeeded=true），
  // 本轮用户的输入就是在回答这个追问（点了方向快捷回复 或 直接打字回答方向）。
  // 此时绝不能走 LLM 意图识别 —— LLM 看不到上下文，会把"AI 应用开发"这种短语识别成
  // general_inquiry，最后路由进 general_qa，但 RAG 会命中相关知识库再"伪装"成学习计划，
  // 导致 quickReplies 是技术追问而不是"确认计划"。
  // 强制 create_task，下游 shouldClarifyTaskPlan 已能正确判定为"信息充足"继续生成计划。
  if (state.clarificationNeeded === true) {
    logger.info("Intent fast-path: 继续上一轮 task_generation 追问的回答");
    return {
      userIntent: "create_task",
      intentDecision: {
        reasoning: "上一轮已发起 clarification，本轮是用户对方向的回答",
        keywords: [],
      },
      clarificationNeeded: false, // 一次性消费，避免下一轮还卡在 task 路径
    };
  }

  // Fast path: 本地规则命中直接返回（0 LLM 调用）
  const ruleHit = ruleBasedIntent(content);
  if (ruleHit) {
    logger.info(`Intent fast-path: ${ruleHit.intent} | ${ruleHit.reasoning}`);
    return {
      userIntent: ruleHit.intent,
      intentDecision: { reasoning: ruleHit.reasoning, keywords: ruleHit.keywords },
    };
  }

  const intentPrompt = SYSTEM_PROMPTS.INTENT_RECOGNITION.replace("{message}", content);

  try {
    // 用轻量模型，避免 qwen3.6-plus 的 1-2 秒延迟
    const llm = createLightLLM();
    const response = await llm.invoke([new HumanMessage(intentPrompt)]);
    const raw = response.content as string;
    const parsed = parseIntentResponse(raw);

    logger.info(`Detected intent: ${parsed.intent} | reasoning: ${parsed.reasoning}`);

    return {
      userIntent: parsed.intent,
      intentDecision: {
        reasoning: parsed.reasoning,
        keywords: parsed.keywords,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Intent recognition failed", err);
    return {
      userIntent: "general_inquiry",
      intentDecision: { reasoning: "意图识别异常，回落通用问答", keywords: [] },
    };
  }
}

/**
 * 早安问候节点
 */
export async function morningGreetingNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  logger.info("Morning greeting node executing");

  try {
    const llm = createLLM();
    const contextEnhancer = getContextEnhancer();
    const context = await contextEnhancer.enhanceContext(state.userId, "");

    const systemPrompt = SYSTEM_PROMPTS.MORNING_GREETING;
    const userPrompt = `用户ID：${state.userId}\n${contextEnhancer.generateSystemPromptEnhancement(context)}`;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const quickReplies = ["开始今天的学习", "调整学习计划", "查看学习进度"];

    LogTools.logAgentDecision(state.userId, state.userIntent, "Morning greeting");

    return {
      messages: [...state.messages, new AIMessage(response.content as string)],
      quickReplyOptions: createQuickReplies(quickReplies),
      waitingForUserInput: true,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Morning greeting failed", err);
    const errorMessage = "早上好！☀️ 今天又是充满希望的一天。准备好了吗？";
    return {
      messages: [...state.messages, new AIMessage(errorMessage)],
      quickReplyOptions: createQuickReplies(["开始今天的学习", "调整学习计划", "查看学习进度"]),
      waitingForUserInput: true,
    };
  }
}

/**
 * 晚间复盘节点
 */
export async function eveningReviewNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  logger.info("Evening review node executing");

  try {
    const llm = createLLM();
    const contextEnhancer = getContextEnhancer();
    const context = await contextEnhancer.enhanceContext(state.userId, "");

    const systemPrompt = SYSTEM_PROMPTS.EVENING_REVIEW;
    const userPrompt = `用户ID：${state.userId}\n${contextEnhancer.generateSystemPromptEnhancement(context)}`;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const quickReplies = ["记录今天的学习心得", "查看本周数据", "准备休息"];

    LogTools.logAgentDecision(state.userId, state.userIntent, "Evening review");

    return {
      messages: [...state.messages, new AIMessage(response.content as string)],
      quickReplyOptions: createQuickReplies(quickReplies),
      waitingForUserInput: true,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Evening review failed", err);
    const errorMessage = "晚上好！🌙 今天辛苦了，早点休息哦～";
    return {
      messages: [...state.messages, new AIMessage(errorMessage)],
      quickReplyOptions: createQuickReplies(["记录今天的学习心得", "查看本周数据", "准备休息"]),
      waitingForUserInput: true,
    };
  }
}

/**
 * 检测用户原始需求是否足够生成计划
 *
 * 充足判定：消息里能识别出明确的技术栈方向。
 * 否则需要反问用户具体想学什么。
 */
function detectTechStackSignal(text: string): { matched: boolean; label: string | null } {
  const checks: Array<[RegExp, string]> = [
    [/(React|Reactjs|响应式组件|jsx)/i, "React 开发"],
    [/(Vue|vue3|vue\.js)/i, "Vue 开发"],
    [/(Next\.?js|SSR|全栈)/i, "Next.js 实战"],
    [/(TypeScript|TS|类型体操|类型推导)/i, "TypeScript 进阶"],
    [/(JavaScript深入|原型链|闭包|JS 基础|js基础)/i, "JavaScript 深入"],
    [/(CSS|布局|Flex|Grid|动画|样式)/i, "CSS 布局"],
    [/(Node\.?js|后端|Express|API 开发)/i, "Node.js 后端"],
    [/(算法|LeetCode|刷题|数据结构)/i, "算法刷题"],
    [/(进阶|大厂|底层|架构|工程化)/i, "前端进阶"],
    [/(AI|LangChain|Agent|大模型|RAG)/i, "AI 应用开发"],
  ];
  for (const [re, label] of checks) {
    if (re.test(text)) return { matched: true, label };
  }
  return { matched: false, label: null };
}

/**
 * 判断 create_task 当前轮是否需要追问用户
 *
 * 充足条件（满足任一即可）：
 * 1. 用户本轮输入命中明确技术栈
 * 2. 用户本轮输入是对前一轮反问的回答（前一条 assistant 是 clarification 反问）
 * 3. 已经存在"上一份计划"（说明是调整流程，沿用前一份的 tech_stack）
 */
export function shouldClarifyTaskPlan(state: GraphStateType): { needClarify: boolean } {
  const lastUserMessage = state.messages.filter((m: any) => (m.role || m._getType?.()) === "user").pop();
  const userText = typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "";

  // 本轮命中明确技术栈 → 信息够
  if (detectTechStackSignal(userText).matched) return { needClarify: false };

  // 上一条 assistant 含追问标识 → 用户本轮是在回答 → 信息够
  for (let i = state.messages.length - 2; i >= 0; i--) {
    const msg: any = state.messages[i];
    const role = msg.role || msg._getType?.();
    const c = typeof msg.content === "string" ? msg.content : "";
    if (role === "assistant" || role === "ai") {
      if (c.includes("【需求确认】") || c.includes("你最想专攻") || c.includes("📋") || c.includes("学习计划")) {
        return { needClarify: false };
      }
      break;
    }
  }

  return { needClarify: true };
}

/**
 * 构造追问消息（带快捷回复，让用户在不需要打字的情况下回答）
 */
export function buildClarificationMessage(): string {
  return [
    "【需求确认】",
    "",
    "好的！来一起规划一份学习计划 📋",
    "",
    "在动手生成之前，先了解一下你的想法：",
    "",
    "**你最想专攻哪个方向？**",
    "",
    "如果不在下面的快捷选项里，也可以直接打字告诉我，比如 _\"想做 Electron 桌面端\"_ / _\"想钻研前端架构\"_。",
  ].join("\n");
}

/**
 * 任务生成节点
 */
export async function taskGenerationNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  logger.info("Task generation node executing");

  try {
    // === 多轮对话：先检查需求是否充足 ===
    const { needClarify } = shouldClarifyTaskPlan(state);
    if (needClarify) {
      logger.info("Task generation: 需求不充足，进入追问轮");
      const clarifyContent = buildClarificationMessage();
      return {
        messages: [...state.messages, new AIMessage(clarifyContent)],
        quickReplyOptions: createQuickReplies([
          "React 开发",
          "Vue 开发",
          "TypeScript 进阶",
          "前端进阶",
          "AI 应用开发",
          "刷算法",
        ]),
        waitingForUserInput: true,
        clarificationNeeded: true,
      };
    }

    // 任务生成需要严格结构化输出 + 多约束 → 升档到 T3（默认 qwen-max）
    const llm = createLLM({ task: "task_generation" });
    const mcpClient = getMCPToolClient();

    // 获取用户原始消息
    const lastUserMessage = state.messages.filter(m => m.role === "user").pop();
    const userRequest = typeof lastUserMessage?.content === "string"
      ? lastUserMessage.content
      : "用户想学习技术";

    const ragResult = await mcpClient.searchKnowledge({
      query: `用户 ${state.userId} 的技术学习进度`,
      category: "user_history",
      topK: 3,
    });

    let ragContext = "";
    if (ragResult.success && ragResult.data?.results?.length > 0) {
      ragContext = ragResult.data.results.map((r: any) => r.content).join("\n");
    }

    const systemPrompt = SYSTEM_PROMPTS.TASK_GENERATION;
    const userPrompt = TASK_PROMPTS.GENERATE_TASK_PLAN
      .replace("{userId}", state.userId)
      .replace("{progress}", ragContext || "暂无进度数据")
      .replace("{weakModules}", "待分析")
      .replace("{studyHabits}", "待分析");

    // 抽取上一份计划（如果存在），作为"调整"场景的上下文
    // 触发条件：messages 中有上一条 assistant 消息且包含计划标识
    let previousPlan: string | null = null;
    for (let i = state.messages.length - 2; i >= 0; i--) {
      const msg: any = state.messages[i];
      const role = msg.role || (msg._getType ? msg._getType() : "");
      const c = typeof msg.content === "string" ? msg.content : "";
      if ((role === "assistant" || role === "ai") && (c.includes("学习计划") || c.includes("tech_stack") || c.includes("📋"))) {
        previousPlan = c;
        break;
      }
    }

    // 把用户原始需求 + 上一份计划（如有）都传给模型
    const adjustmentContext = previousPlan
      ? `\n上一份计划：\n${previousPlan}\n\n请基于上一份计划做有针对性的调整（不要重复输出一遍）。\n`
      : "";

    const enhancedUserPrompt = `用户具体需求：${userRequest}${adjustmentContext}

${userPrompt}`;

    if (previousPlan) {
      console.log("📋 [Task] 检测到上一份计划，进入调整模式");
    }

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(enhancedUserPrompt),
    ]);

    const quickReplies = ["确认计划", "调整任务", "取消"];
    const parsedTaskPlan = parseTaskPlanFromText(response.content as string);

    LogTools.logAgentDecision(state.userId, state.userIntent, "Task generation");

    return {
      messages: [...state.messages, new AIMessage(response.content as string)],
      quickReplyOptions: createQuickReplies(quickReplies),
      waitingForUserInput: true,
      ragResults: ragResult.success ? ragResult.data?.results : [],
      pendingTaskPlan: parsedTaskPlan ?? undefined,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Task generation failed", err);
    const errorMessage = "抱歉，生成任务计划时出错了。请稍后再试。";
    return {
      messages: [...state.messages, new AIMessage(errorMessage)],
      quickReplyOptions: createQuickReplies(["重试", "取消"]),
      waitingForUserInput: true,
    };
  }
}

/**
 * 情感支持节点
 */
export async function emotionSupportNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  logger.info("Emotion support node executing");

  try {
    const llm = createLLM();
    const emotionDetector = getEmotionDetector();
    const lastMessage = state.messages[state.messages.length - 1];
    const content = lastMessage.content as string;

    const emotionResult = emotionDetector.detectEmotion(content);
    const emotionLabel = emotionDetector.getEmotionLabel(emotionResult.emotion);
    const emotionDescription = emotionDetector.getEmotionDescription(
      emotionResult.emotion,
      emotionResult.intensity
    );

    const mcpClient = getMCPToolClient();
    const ragResult = await mcpClient.searchKnowledge({
      query: `${emotionResult.emotion} 备考经验 解决方案`,
      category: "exam_experience",
      topK: 3,
    });

    let ragContext = "";
    if (ragResult.success && ragResult.data?.results?.length > 0) {
      // 情感支持场景下，RAG 的作用是补“别人怎么走出来”的经验语境，
      // 不是机械罗列知识点，所以这里只保留可直接转成安抚建议的内容。
      ragContext = ragResult.data.results.map((r: any) => r.content).join("\n");
    }

    const systemPrompt = SYSTEM_PROMPTS.EMOTION_SUPPORT;
    const userPrompt = `用户情绪：${emotionLabel} (${emotionDescription})\n相关经验：${ragContext || "暂无相关经验"}\n用户消息：${content}`;

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    const quickReplies = ["分析薄弱模块", "制定突破计划", "我再想想"];

    LogTools.logAgentDecision(state.userId, state.userIntent, "Emotion support");

    return {
      messages: [...state.messages, new AIMessage(response.content as string)],
      quickReplyOptions: createQuickReplies(quickReplies),
      waitingForUserInput: true,
      ragResults: ragResult.success ? ragResult.data?.results : [],
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Emotion support failed", err);
    const errorMessage = "我理解你的感受，有什么我可以帮助你的吗？";
    return {
      messages: [...state.messages, new AIMessage(errorMessage)],
      quickReplyOptions: createQuickReplies(["继续对话", "结束对话"]),
      waitingForUserInput: true,
    };
  }
}

/**
 * 进度查询节点
 */
export async function progressQueryNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  logger.info("Progress query node executing");

  try {
    const llm = createLLM();
    const mcpClient = getMCPToolClient();
    const ragResult = await mcpClient.searchKnowledge({
      query: `用户 ${state.userId} 的学习进度数据`,
      category: "user_history",
      topK: 5,
    });

    let progressData = "";
    if (ragResult.success && ragResult.data?.results?.length > 0) {
      progressData = ragResult.data.results.map((r: any) => r.content).join("\n");
    }

    const systemPrompt = SYSTEM_PROMPTS.GENERAL_QA;
    const userPrompt = TASK_PROMPTS.QUERY_PROGRESS.replace("{userId}", state.userId);

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    LogTools.logAgentDecision(state.userId, state.userIntent, "Progress query");

    return {
      messages: [...state.messages, new AIMessage(response.content as string)],
      quickReplyOptions: createQuickReplies(["继续提问", "查看详细进度", "返回首页"]),
      waitingForUserInput: false,
      ragResults: ragResult.success ? ragResult.data?.results : [],
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Progress query failed", err);
    const errorMessage = "抱歉，查询学习进度时出错了。请稍后再试。";
    return {
      messages: [...state.messages, new AIMessage(errorMessage)],
      quickReplyOptions: createQuickReplies(["重试", "返回首页"]),
      waitingForUserInput: false,
    };
  }
}

/**
 * 一般问答节点
 */
export async function generalQANode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  logger.info("General QA node executing");

  try {
    const llm = createLLM();
    const lastMessage = state.messages[state.messages.length - 1];
    const content = lastMessage.content as string;

    const contextEnhancer = getContextEnhancer();
    const enhancedMessage = await contextEnhancer.enhanceUserMessage(state.userId, content);
    const config = getAgentConfig();

    // ========== 四层记忆融合检索 ==========
    console.log("\n");
    console.log("🧠 [Memory] 开始四层记忆融合检索");

    // 转换消息格式为 Memory Message
    const memoryMessages: Message[] = state.messages.map((msg: any) => ({
      role: msg.role || (msg._getType ? msg._getType() : "user"),
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    }));

    // 执行四层记忆融合检索
    const memoryRetriever = getMemoryFusionRetriever();
    const fusedMemory = await memoryRetriever.retrieve(
      state.userId,
      content,
      memoryMessages
    );

    // 将融合后的上下文添加到系统提示
    const memoryContextPrompt = fusedMemory.fusedContext;
    console.log(`🧠 [Memory] 融合上下文已生成，长度: ${memoryContextPrompt.length} 字符`);

    // 使用 LlamaIndex HybridFusion + BGE-M3 重排 + 三级策略的 RAG 检索
    let ragContext = "";
    let ragResults: any[] = [];

    if (config.features.ragEnabled && shouldRouteToXiaohongshuRag(content)) {
      const ragFallbackResult = await retrieveWithFallback(content, { topK: 5, userId: state.userId });
      ragContext = ragFallbackResult.context;
      ragResults = ragFallbackResult.results;
      console.log(`[RAG] source=${ragFallbackResult.source} tier=${ragFallbackResult.tier} hits=${ragResults.length}`);
    }

    // 构建 prompt：优先使用 RAG context，否则使用原始消息
    const userPrompt = ragContext || enhancedMessage;

    const systemPrompt = SYSTEM_PROMPTS.DEFAULT;
    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ]);

    LogTools.logAgentDecision(state.userId, state.userIntent, "General QA");

    return {
      messages: [...state.messages, new AIMessage(response.content as string)],
      quickReplyOptions: createQuickReplies(["继续提问", "深入这个话题", "换个话题"]),
      waitingForUserInput: false,
      ragResults,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("General QA failed", err);
    const errorMessage = "抱歉，我无法理解你的问题。请换个方式问我。";
    return {
      messages: [...state.messages, new AIMessage(errorMessage)],
      quickReplyOptions: createQuickReplies(["重试", "换个话题"]),
      waitingForUserInput: false,
    };
  }
}

/**
 * 响应生成节点
 */
export async function generateResponseNode(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  logger.info("Generate response node executing");

  return {
    waitingForUserInput: false,
  };
}

/**
 * 流式版本的节点函数
 */

/**
 * 规范化消息内容：从 DB 恢复的 state.messages 是纯 JSON 对象，
 * content 字段可能为 undefined、数组或字符串。
 * 此处统一转为字符串，避免传给 LangChain 消息构造函数时报错。
 */
function normalizeMessageContent(msg: any): string {
  if (msg.content === undefined || msg.content === null) return "";
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c: any) => (typeof c === "string" ? c : c?.text || ""))
      .join(" ");
  }
  if (typeof msg.content !== "string") {
    return JSON.stringify(msg.content);
  }
  return msg.content;
}

/**
 * 将 state.messages 数组中可能混杂的 LangChain 消息对象和纯 JSON
 * 对象统一映射为 LangChain 消息实例，用于构建 LLM prompt。
 */
function buildLLMMessages(messages: any[]): any[] {
  return messages.map((msg: any) => {
    if (msg.lc_serializable === true) return msg;
    const content = normalizeMessageContent(msg);
    if (msg.role === "user") return new HumanMessage(content);
    if (msg.role === "assistant") return new AIMessage(content);
    return new HumanMessage(content);
  });
}

export async function* generalQANodeStream(
  state: GraphStateType
): AsyncGenerator<StreamChunk, GraphStateType, unknown> {
  logger.info("General QA stream node executing (with thinking mode)");

  try {
    const lastMessage = state.messages[state.messages.length - 1];
    const content = lastMessage.content as string;

    // ========== 输入侧 SSRF / 内网地址短路（串话回归修复点）==========
    // 2026-05-19 服务器实测：用户问"上网查 http://localhost:8000/admin"，
    // web_search 被 L2 SSRF 正确拦下返回 null，但随后 prompt 装配里
    // `if (webResult && ...)` 把整个联网块跳过 → 模型完全不知道"联网试过且为空"，
    // 拿着 DEFAULT 人设 + 污染历史裸奔，把人设背一遍并把历史里拼多多/成龙等
    // 旧话题一次性扫答（典型 context-bleed）。
    // 根因不是规则缺失，是 buildAnswerRules 第 3 条锚在了模型感知不到的状态上。
    // 修法：内网/SSRF 探测在跑完整 pipeline 前就短路——给一句诚实、紧扣本问题的
    // 拒答，绝不进入记忆/RAG/历史链路，从源头消除串话可能。pattern 复用
    // guardrail 的 SSRF_INTERNAL_PATTERN 单一来源（与 L2 工具守卫同一条规则）。
    const ssrfMatch = content.match(SSRF_INTERNAL_PATTERN);
    if (ssrfMatch) {
      // 写一条 guardrail.input 错误 span：
      //  ① 让 Trace Viewer 如实显示"被输入侧 SSRF 闸拦截"，而不是零 guard span；
      //  ② route.ts 据此把 GuardRail 摘要的 input 层标 block（与 L2 同一套 span 机制）。
      const _trace = getCurrentTrace();
      if (_trace) {
        const _sp = _trace.startSpan("guardrail.input");
        _sp.setAttributes({
          layer: "input",
          reason: "SSRF / 内网访问",
          matchedText: (ssrfMatch[0] || "").slice(0, 60),
          maxRisk: "high",
          blocked: true,
        });
        _trace.endSpan(_sp, "error", "SSRF / 内网访问短路拦截");
      }
      yield {
        type: "step",
        text: "",
        stepId: "input_guard",
        stepLabel: "输入安全检查",
        stepIcon: "🛡️",
        stepStatus: "done",
        stepDetail: "识别到内网/SSRF 探测地址，短路拒答（不进入检索/记忆/历史链路）",
      };
      const ssrfReply =
        "我无法访问内网或本机地址（如 `localhost`、`127.0.0.1`、私有网段 `192.168.x` / `10.x` / `172.16-31.x`，以及 `file://` 等协议）。" +
        "这类地址只有你本机或内网能打开，我运行在隔离环境、没有对内网的出向访问权限，也看不到页面内容或登录态。\n\n" +
        "如果你想排查这个本地后台，可以在**你自己的浏览器/终端**里确认：服务是否在跑、端口是否正确、控制台/Network 有没有报错。" +
        "需要的话，把报错信息贴给我，我可以帮你分析，或写一个最小可运行的后台模板。";
      yield { type: "content", text: ssrfReply };
      LogTools.logAgentDecision(state.userId, state.userIntent, "SSRF Short-Circuit");
      return {
        ...state,
        messages: [...state.messages, new AIMessage(ssrfReply)],
        quickReplyOptions: createQuickReplies([
          "这个本地后台怎么排查？",
          "帮我写个后台最小模板",
          "换个问题",
        ]),
        waitingForUserInput: false,
      };
    }

    // ========== 用户身份抽取（在记忆检索前先持久化姓名）==========
    // 这样如果用户说"我叫小明"，会立刻写入 UserProfile.nickname，
    // 紧随其后的记忆融合就会在 fusedContext 顶部带上"用户称呼"。
    await detectAndSaveNickname(state.userId, content);

    const contextEnhancer = getContextEnhancer();
    const enhancedMessage = await contextEnhancer.enhanceUserMessage(state.userId, content);
    const config = getAgentConfig();

    // 任务查询型问题（"我今天该做什么"/"今日任务"等）短路 RAG + web：
    // 这类问题的"权威答案"在本地 SQLite Task 表里（systemPrompt 已注入），
    // 跑 RAG / 联网搜索不仅无意义还会引入不相关的参考来源（用户实测：Tavily 返回的
    // 链接和任务八竿子打不着）。memory 仍跑，因为画像/历史会让回答更有针对性。
    const isTaskQuery = [
      "今天该做什么", "今天做什么", "今天要做什么", "我今天该做", "我今天有",
      "今日任务", "今天的任务", "还有什么没做", "还剩什么", "我有什么任务", "我的任务",
    ].some((kw) => content.includes(kw));

    // ========== P4-A：模型自主工具决策（function calling 痕迹）==========
    // 把"查不查 KB / 要不要联网 / 检索 query"从关键词正则升级为模型一次结构化决策。
    // 任务查询本地权威 → 跳过决策；模型决策解析失败 → 回退原启发式（零风险降级）。
    yield {
      type: "step",
      text: "",
      stepId: "tool_decision",
      stepLabel: "工具决策 (function calling)",
      stepIcon: "🛠️",
      stepStatus: "running",
    };
    const toolPlan = isTaskQuery
      ? {
          useKb: false,
          useWeb: false,
          refinedQuery: content,
          reason: "任务查询：本地 SQLite 任务表是权威来源，不调用外部检索",
          modelDecided: true as boolean,
        }
      : await planRetrieval(content);
    const planFellBack = !toolPlan.modelDecided;
    const retrievalQuery = toolPlan.refinedQuery || content;
    // KB 启用：模型决策；解析失败时回退原启发式 shouldRouteToXiaohongshuRag
    const wantKb = planFellBack ? shouldRouteToXiaohongshuRag(content) : toolPlan.useKb;
    yield {
      type: "step",
      text: "",
      stepId: "tool_decision",
      stepLabel: "工具决策 (function calling)",
      stepIcon: "🛠️",
      stepStatus: "done",
      stepDetail: planFellBack
        ? `模型决策不可用 → 回退关键词启发式（kb=${wantKb}）`
        : `模型决策 kb=${toolPlan.useKb} web=${toolPlan.useWeb}${
            retrievalQuery !== content ? ` · 改写="${retrievalQuery}"` : ""
          } · ${toolPlan.reason}`,
    };
    logAgentEvent({
      userId: state.userId,
      eventType: "rag",
      eventName: "tool_decision",
      payload: {
        modelDecided: toolPlan.modelDecided,
        isTaskQuery,
        useKb: toolPlan.useKb,
        useWeb: toolPlan.useWeb,
        originalQuery: content, // 原始口语化问题，与 refinedQuery 配对，便于离线核查改写质量/命中率
        refinedQuery: retrievalQuery,
        rewritten: retrievalQuery !== content,
        reason: toolPlan.reason,
      },
    });

    // ========== Memory + RAG 并行检索（性能优化）==========
    // 两条链路无数据依赖：memory 用 long_term_memory collection，RAG 用 tech_knowledge collection
    // 串行 4-7s → 并行 max ≈ 2-4s，省 ~40-50% 等待时间
    const memT0 = Date.now();
    yield {
      type: "step",
      text: "",
      stepId: "memory",
      stepLabel: "融合四阶分层记忆",
      stepIcon: "🧠",
      stepStatus: "running",
    };

    // wantKb 来自上面的模型决策（回退时已是原启发式）
    const ragEnabled = !isTaskQuery && config.features.ragEnabled && wantKb;
    if (ragEnabled) {
      yield {
        type: "step",
        text: "",
        stepId: "rag",
        stepLabel: "检索本地知识库",
        stepIcon: "🔍",
        stepStatus: "running",
      };
    }

    const memoryMessages: Message[] = state.messages.map((msg: any) => ({
      role: msg.role || (msg._getType ? msg._getType() : "user"),
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
    }));

    const memoryRetriever = getMemoryFusionRetriever();
    const memoryPromise = memoryRetriever.retrieve(state.userId, content, memoryMessages);
    const ragPromise = ragEnabled
      ? retrieveWithFallback(retrievalQuery, { topK: 5, userId: state.userId })
      : Promise.resolve(null);

    // 并行执行（关键点）
    const [fusedMemory, ragFallbackResult] = await Promise.all([memoryPromise, ragPromise]);

    const memoryContextPrompt = fusedMemory.fusedContext;
    console.log(`🧠 [Memory] 融合上下文已生成，长度: ${memoryContextPrompt.length} 字符`);

    const memElapsed = Date.now() - memT0;
    yield {
      type: "step",
      text: "",
      stepId: "memory",
      stepLabel: "融合四阶分层记忆",
      stepIcon: "🧠",
      stepStatus: "done",
      stepDetail: `瞬时${state.messages.length}条 · 短期/长期/元 共 ${memoryContextPrompt.length} 字符上下文 · ${memElapsed}ms`,
    };

    let ragContext = "";
    let ragResults: any[] = [];
    if (ragFallbackResult) {
      ragContext = ragFallbackResult.context;
      ragResults = ragFallbackResult.results;
      yield {
        type: "step",
        text: "",
        stepId: "rag",
        stepLabel: "检索本地知识库",
        stepIcon: "🔍",
        stepStatus: "done",
        stepDetail: `LlamaIndex 混合检索 · 命中 ${ragResults.length} 条 · ${ragFallbackResult.tier} · ${memElapsed}ms（与记忆并行）`,
      };
    } else {
      yield {
        type: "step",
        text: "",
        stepId: "rag",
        stepLabel: "检索本地知识库",
        stepIcon: "🔍",
        stepStatus: "skip",
        stepDetail: "问题不属于知识库分类，跳过",
      };
    }

    console.log(`[RAG] hits=${ragResults.length}`);

    // ========== 联网搜索智能路由 ==========
    // 触发条件：RAG tier=fallback/expand 或问题命中时效/显式联网关键词
    // 任务查询直接跳过——"今天"会被时效关键词命中触发 Tavily，但任务答案在本地 DB
    let webResult: WebSearchResult | null = null;

    // ===== 真 tier 驱动检索恢复（A 治本 + B1 多源，逻辑见 retrieval-decision.ts）=====
    // 旧代码用 `ragResults.length>0 ? "candidates" : undefined` 捏假 tier，丢了真实
    // 低置信信号。这里取真 tier，决策走纯函数单一来源（可确定性单测）。
    const kbTier = ragFallbackResult?.tier ?? "";
    const kbConfident = isKbConfident(kbTier, ragResults.length);
    const doWebSearch = decideWeb({
      isTaskQuery,
      modelUseWeb: toolPlan.useWeb,
      planFellBack,
      heuristicWeb: shouldUseWebSearch(content, kbTier || undefined),
      tier: kbTier,
    });
    if (doWebSearch) {
      const webT0 = Date.now();
      yield {
        type: "step",
        text: "",
        stepId: "web",
        stepLabel: "联网搜索",
        stepIcon: "🌐",
        stepStatus: "running",
      };
      webResult = await webSearch(retrievalQuery);
      const webDuration = Date.now() - webT0;
      // 写入事件日志，供 Dashboard 累加 webCount
      logAgentEvent({
        userId: state.userId,
        eventType: "rag",
        eventName: "web_search",
        payload: {
          webCount: webResult?.citations.length ?? 0,
          success: !!webResult,
          provider: webResult?.provider,
          ragTier: kbTier || null, // 真 tier（precise/candidates/expand/fallback）
          kbConfident, // 本次 KB 是否算可信命中（observability）
          // P3 可观测：多源核对是否启用 + 来源一致度（弱信号）。
          // Dashboard / P6 eval 据此统计「多源覆盖率」「低一致度触发率」
          multiSource: webResult?.multiSource ?? false,
          sourceCount: webResult?.topSources?.length ?? 0,
          agreement: webResult?.agreement ?? null,
          query: content.slice(0, 80),
        },
        durationMs: webDuration,
      });
      yield {
        type: "step",
        text: "",
        stepId: "web",
        stepLabel: "联网搜索",
        stepIcon: "🌐",
        stepStatus: webResult ? "done" : "skip",
        stepDetail: webResult
          ? `${webResult.provider === "serper" ? "Serper" : "Tavily"} · ${webResult.citations.length} 个来源 · ${
              webResult.multiSource
                ? typeof webResult.agreement === "number"
                  ? `多源核对(主题相似度 ${Math.round(webResult.agreement * 100)}%·非事实一致)`
                  : "多源核对(主题相似度未计算)"
                : "单源"
            } · ${webDuration}ms`
          : "联网搜索调用失败，跳过",
      };
    } else {
      yield {
        type: "step",
        text: "",
        stepId: "web",
        stepLabel: "联网搜索",
        stepIcon: "🌐",
        stepStatus: "skip",
        stepDetail: "本地知识充足且无时效关键词，跳过",
      };
    }

    // ========== P2：检索路由（把"用哪类知识源"这个隐式决策显式化 + 可观测）==========
    // 早期设计问题："只有分类标签没有路由可观测、没有占比指标"。这里不改图拓扑，
    // 而是把 general_qa 内部"KB / 联网 / 记忆"的实际取舍升级成一等公民信号：
    // 出 step（前端轨迹可见）+ 写事件日志（Dashboard / P6 可统计各路由占比）。
    // 用真置信：expand/fallback 不算"本地命中"，路由如实标 web_only / model_knowledge
    const hasKBHit = kbConfident;
    const hasWebHit = !!webResult;
    const hasMemoryHit = !!(memoryContextPrompt && memoryContextPrompt.trim().length > 0);
    const retrievalRoute = hasKBHit && hasWebHit
      ? "kb+web"
      : hasKBHit
        ? "kb_only"
        : hasWebHit
          ? "web_only"
          : hasMemoryHit
            ? "memory_grounded"
            : "model_knowledge";
    const routeReason = {
      "kb+web": "本地知识库命中 + 触发联网补充，交叉作答",
      kb_only: "本地知识库命中，足以作答",
      web_only: "本地无命中，转联网搜索",
      memory_grounded: "无外部知识，基于对话记忆/用户画像作答",
      model_knowledge: "无外部知识源，依赖模型通用知识（已据此降低可信度声明）",
    }[retrievalRoute];
    console.log(`🧭 [RetrievalRoute] ${retrievalRoute} | ${routeReason} | kb=${ragResults.length} web=${hasWebHit} mem=${hasMemoryHit}`);
    logAgentEvent({
      userId: state.userId,
      eventType: "rag",
      eventName: "retrieval_route",
      payload: {
        route: retrievalRoute,
        hasKB: hasKBHit,
        hasWeb: hasWebHit,
        hasMemory: hasMemoryHit,
        kbHits: ragResults.length,
        // P4-A 协同：该路由是模型决策的结果，而非事后启发式观测
        modelDecided: toolPlan.modelDecided,
        queryRewritten: retrievalQuery !== content,
      },
    });
    yield {
      type: "step",
      text: "",
      stepId: "route",
      stepLabel: "检索路由",
      stepIcon: "🧭",
      stepStatus: "done",
      stepDetail: `${retrievalRoute} · ${routeReason}`,
    };

    // ========== 装配 systemPrompt：DEFAULT + 四阶记忆 + RAG 带来源 + 来源规则 ==========
    let enhancedSystemPrompt = SYSTEM_PROMPTS.DEFAULT;
    const usedSources: Array<{ type: "memory" | "kb" | "web"; title: string; detail?: string; url?: string; score?: number }> = [];

    if (memoryContextPrompt && memoryContextPrompt.trim().length > 0) {
      enhancedSystemPrompt += `\n\n## 🧠 对话记忆与用户画像\n${memoryContextPrompt}`;
      usedSources.push({ type: "memory", title: "四阶分层记忆", detail: "瞬时/短期/长期/元记忆融合" });
    }

    // 仅 precise/candidates 才把 KB 当依据展示+注入；expand/fallback 的低置信
    // 残渣不上桌（不进 usedSources、不进 prompt）——A 治本核心。
    if (kbConfident) {
      const ragBlock = ragResults
        .map((r, i) => {
          const title = r.metadata?.title || `知识点 ${i + 1}`;
          const category = r.metadata?.category ? ` · ${r.metadata.category}` : "";
          const text = (r.content || "").trim();
          // 透传 metadata.source_url（content-ingestion 写入时已保存原文链接）
          // 这样前端 SourcesSection 可以渲染成可点的 <a target="_blank">
          const url = (r.metadata?.source_url || r.metadata?.sourceUrl || "").trim() || undefined;
          // detail 透传知识点正文片段（截短到 400 字），用于 GuardRail L3 事实交叉验证
          // 不传完整 content 是避免 SSE payload 膨胀 / 前端展示溢出
          const detailSnippet = text.length > 0 ? text.slice(0, 400) : undefined;
          usedSources.push({ type: "kb", title: `${title}${category}`, detail: detailSnippet, score: r.score, url });
          return `${i + 1}. 【📚 本地知识库 · ${title}${category}】\n${text}`;
        })
        .join("\n\n");
      enhancedSystemPrompt += `\n\n## 📚 本地知识库检索结果\n${ragBlock}`;
    }

    // ========== 注入"今日任务"上下文 ==========
    // 让 Agent 在被问到「我今天该做什么」「我有什么任务」时能直接列出实际的任务，
    // 而不是说"我不知道你的任务"。任务来自 SQLite Task 表，按截止时间分桶。
    // best-effort：DB 异常时降级为空（不影响主对话）
    try {
      const taskService = getTaskService();
      const taskSummary = await taskService.getTodaySummary(state.userId);
      const allLists = [
        ["⚠️ 已逾期", taskSummary.overdue],
        ["🔥 今日到期", taskSummary.todayDue],
        ["📅 明日到期", taskSummary.tomorrowDue],
      ] as const;
      const hasAny = allLists.some(([, arr]) => arr.length > 0);
      if (hasAny) {
        const block = allLists
          .filter(([, arr]) => arr.length > 0)
          .map(([label, arr]) => {
            const items = arr
              .slice(0, 5)
              .map((t: { title: string; module: string | null }) => `  - ${t.title}${t.module ? ` (${t.module})` : ""}`)
              .join("\n");
            const more = arr.length > 5 ? `\n  - ...还有 ${arr.length - 5} 条` : "";
            return `${label}（${arr.length} 条）：\n${items}${more}`;
          })
          .join("\n\n");
        enhancedSystemPrompt += `\n\n## 📋 用户当前的学习任务\n${block}\n\n回答任务相关问题（如"我今天该做什么"、"还有什么没做"）时，必须以上面真实任务为准，不要编造任务。如果用户没问任务，可以不主动提及。`;
      }
    } catch (e: any) {
      console.warn("[general_qa] inject task context failed:", e?.message || e);
    }

    if (webResult && (webResult.answer || (webResult.topSources?.length ?? 0) > 0)) {
      const webCitations = webResult.citations.slice(0, 5);
      // P3：把多个独立来源逐条编号喂给模型，要求交叉核对而不是只信第一条。
      const sourcesForPrompt =
        webResult.topSources && webResult.topSources.length > 0
          ? webResult.topSources
          : webCitations.map((c) => ({ title: c.title || c.url, url: c.url, snippet: c.content || "" }));
      const numberedSources = sourcesForPrompt
        .map((s, i) => `[来源${i + 1}] ${s.title}\n${(s.snippet || "").trim() || "（无正文摘要）"}\n（${s.url}）`)
        .join("\n\n");
      // 注意：不再用 agreement 阈值去 gate 冲突提示。
      // 原因：embedding 语义相似度衡量的是"来源是否在谈同一件事"，
      // 不是"事实是否一致"——5 篇都讲'2026 薪资'的文章，哪怕数字打架，余弦仍 ~0.5+。
      // 所以交叉核对指令**无条件注入**，冲突判定只靠 LLM 真读来源（唯一诚实机制）。
      enhancedSystemPrompt += `\n\n## 🌐 联网搜索结果（${sourcesForPrompt.length} 个独立来源，含域名，可据此判断权威性）
${webResult.answer ? `综合摘要：${webResult.answer}\n\n` : ""}${numberedSources}

【多源核对与可信度要求 — 必须逐条执行】
1. 逐个来源交叉核对：对关键事实（数字 / 时间 / 结论），先比对各来源是否一致。${kbConfident ? "本场景同时给了【📚 本地知识库】块，须把本地知识库与各 web 来源**一并**交叉核对；二者冲突时同样要把分歧呈现给用户，不得只采信一方。" : ""}
2. 来源间不一致 → **必须把分歧呈现给用户**：列出不同来源各自的说法 / 数字（可用区间或并列），严禁只采信其中一条而不说明。不强求固定字样，但用户必须看得到"来源说法不一"。
3. **评估来源权威性**（依据上面每条来源的标题与域名）：若来源主要是论坛 / 个人专栏 / 问答 / 营销号 / 培训机构软文（如 CSDN 个人专栏、知乎回答、培训机构站点等），**严禁使用"权威机构""综合预测""官方数据"这类拔高措辞**，必须改用"以下为网络公开信息，口径不一、仅供参考"并提示用户以官方 / 一手渠道为准；仅当来源确为权威（官方统计、一手财报、标准文档）时才可用肯定语气。
4. 不要编造来源里没有的细节。`;
      webCitations.forEach((c) => {
        // detail 透传 citation 正文片段（截短 400 字）——
        // 关键：L3 OutputGuard 的事实交叉验证靠 detail 对照，
        // 不传 detail 联网回答会被判"无来源"直接跳过校验（P1 修复点）
        const webSnippet = (c.content || "").trim();
        usedSources.push({
          type: "web",
          title: c.title || c.url,
          url: c.url,
          detail: webSnippet.length > 0 ? webSnippet.slice(0, 400) : undefined,
        });
      });
      if (webCitations.length === 0) {
        // 没有 citations 时也记一条 web 来源
        usedSources.push({ type: "web", title: "Perplexity Sonar 综合搜索" });
      }
    } else if (doWebSearch) {
      // ========== 联网请求了但没拿到结果（串话回归修复点）==========
      // SSRF 已在输入侧短路；这里兜其余 null 原因：无可用 provider / 超时 /
      // HTTP 错 / 异常。原代码此时整个联网块被跳过 → 模型不知道"联网试过且为空"，
      // buildAnswerRules 第 3 条"联网为空必须如实说没查到"锚在了模型感知不到的
      // 状态上，于是模型拿污染历史拼凑、背人设。这里把"联网为空"显式喂给模型，
      // 给第 3 条一个能感知的真实锚点，并直接堵掉"扫历史 / 背人设"两个具体坏行为。
      // 文案走 buildWebEmptyNotice() 单一来源，context-bleed 回归测的就是这一份。
      enhancedSystemPrompt += `\n\n${buildWebEmptyNotice()}`;
    }

    // P5：把"可引用来源"按 UI 展示顺序统一编号喂给模型，要求行内引用 [n]。
    // 编号必须与前端 SourcesSection 可见来源顺序一致（usedSources 去掉 memory）。
    const citableSources = usedSources.filter((s) => s.type !== "memory");
    const citableList = citableSources
      .map((s, i) => `[${i + 1}] ${s.type === "kb" ? "📚" : "🌐"} ${s.title}`)
      .join("\n");

    // 回答规则（来源不单列区块，但要求行内引用角标 [n]，前端渲染成可点溯源）
    enhancedSystemPrompt +=
      "\n\n" +
      buildAnswerRules({
        hasCitableSources: citableSources.length > 0,
        citableList,
      });

    // ========== 装配历史对话 ==========
    // state.messages 最后一条是当前用户消息，单独作为 userPrompt；前面的作为 history
    // 单条历史截断：上一轮若是长答案(如 1200+ 字)，原样塞进 message 数组会因
    // "最近性"盖过本轮问题 → 模型续答上一轮(串话根因之一)。截断到保留指代/追问
    // 连续性的长度即可(追问"再举个例子"靠这点上下文足够)，不让它霸占语境。
    const HISTORY_MSG_CAP = 500;
    const historyForLLM = state.messages
      .slice(0, -1)
      .map((msg: any) => {
        const rawRole = msg.role || (msg._getType ? msg._getType() : "user");
        const role: "user" | "assistant" =
          rawRole === "assistant" || rawRole === "ai" ? "assistant" : "user";
        let content = typeof msg.content === "string" ? msg.content : "";
        if (content.length > HISTORY_MSG_CAP) {
          content =
            content.slice(0, HISTORY_MSG_CAP) +
            " …〔上一轮内容已截断，仅供指代/追问参考，不要整段重复或延续其主题〕";
        }
        return { role, content };
      })
      .filter((m: any) => m.content && m.content.trim().length > 0);

    console.log(`🧩 [Context] 注入历史消息 ${historyForLLM.length} 条 + memoryPrompt ${memoryContextPrompt.length} 字符 + ragResults ${ragResults.length} 条`);

    // 当前问题置于"最近位置"(history 之后)做主题纪律自检——这是对抗"按最近轮次
    // 延续"的高杠杆点：buildAnswerRules 同义规则埋在长 system prompt 顶部权重被冲淡，
    // 这里贴着生成点重申，且保留正当追问(同主题才延续)，不误杀"再举个例子"类。
    const userPrompt =
      "【作答纪律 · 先自检】判断下面这条问题与上一轮是否同一主题：\n" +
      "· 不同主题 → 完全切换到新主题作答，绝不延续、绝不重复上一轮的内容；\n" +
      "· 确为对上一轮的追问(如「再举个例子」「详细说说那个」) → 才延续上一轮。\n" +
      "然后只回答这一条问题本身：\n" +
      enhancedMessage;

    const genT0 = Date.now();
    // 解析 T2 当前真实使用的 model 名 → 让 stepDetail 跟着路由变化
    const t2Model = resolveTierConfig("T2").model;
    yield {
      type: "step",
      text: "",
      stepId: "generate",
      stepLabel: "生成回答",
      stepIcon: "✨",
      stepStatus: "running",
      stepDetail: `${t2Model} · 注入 ${historyForLLM.length} 条历史 + ${ragResults.length} 条知识 + ${usedSources.filter(s => s.type === "web").length} 个 web 来源`,
    };

    // 使用 DashScope API
    let fullContent = "";
    let fullThought = "";

    for await (const chunk of streamDashscopeAPIWithThinking(enhancedSystemPrompt, userPrompt, {
      history: historyForLLM,
    })) {
      if (chunk.type === "thought") {
        fullThought += chunk.text;
      } else {
        fullContent += chunk.text;
      }
      yield chunk;  // 直接 yield StreamChunk
    }

    // LLM 流式完成后 yield generate done step（让前端 ExecutionStepsSection 显示"已完成"）
    yield {
      type: "step",
      text: "",
      stepId: "generate",
      stepLabel: "生成回答",
      stepIcon: "✨",
      stepStatus: "done",
      stepDetail: `${t2Model} · ${fullContent.length} 字 · ${Date.now() - genT0}ms`,
    };

    LogTools.logAgentDecision(state.userId, state.userIntent, "General QA Stream");

    console.log(`📎 [Sources] 本次使用来源: ${usedSources.map(s => `${s.type}/${s.title}`).join(", ") || "无"}`);

    // ========== 智能快捷回复 ==========
    // 优先用轻量 LLM 基于当前问答生成 3 个相关追问；失败时回落到 buildSmartQuickReplies 模板
    const fallbackReplies = buildSmartQuickReplies({
      hasKB: kbConfident,
      hasWeb: usedSources.some(s => s.type === "web"),
      query: content,
    });
    const smartReplies = await generateContextualQuickReplies(content, fullContent, fallbackReplies);

    return {
      ...state,
      messages: [...state.messages, new AIMessage(fullContent)],
      quickReplyOptions: createQuickReplies(smartReplies),
      waitingForUserInput: false,
      ragResults,
      usedSources,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("General QA stream failed", err);
    yield { type: "content", text: "抱歉，我无法理解你的问题。请换个方式问我。" };

    return {
      ...state,
      messages: [...state.messages, new AIMessage("抱歉，我无法理解你的问题。请换个方式问我。")],
      quickReplyOptions: createQuickReplies(["重试", "换个话题"]),
      waitingForUserInput: false,
    };
  }
}

export async function* taskGenerationNodeStream(
  state: GraphStateType
): AsyncGenerator<string, GraphStateType, unknown> {
  logger.info("Task generation stream node executing");

  try {
    const mcpClient = getMCPToolClient();

    // 获取用户原始消息
    const lastUserMessage = state.messages.filter(m => m.role === "user").pop();
    const userRequest = typeof lastUserMessage?.content === "string"
      ? lastUserMessage.content
      : "用户想学习技术";

    const ragResult = await mcpClient.searchKnowledge({
      query: `用户 ${state.userId} 的技术学习进度`,
      category: "user_history",
      topK: 3,
    });

    let ragContext = "";
    if (ragResult.success && ragResult.data?.results?.length > 0) {
      ragContext = ragResult.data.results.map((r: any) => r.content).join("\n");
    }

    // Step 1: 调用模型生成 JSON 格式的任务计划（不 yield）
    const planSystemPrompt = `你是 TechMate 任务规划引擎。请严格按照 JSON 格式输出学习计划，不要输出其他内容。

输出格式示例：
{"tech_stack":"React开发","daily_practice":"每天3个案例","difficulty":"基础","duration":"预计7天完成","reason":"React是前端核心框架"}

技术栈选项：React开发、Next.js实战、TypeScript进阶、JavaScript深入、CSS布局、Node.js后端、算法刷题、前端进阶`;

    const planUserPrompt = `用户需求：${userRequest}

请生成 JSON 格式的技术学习计划。`;

    let planJson = "";
    // 结构化 JSON 输出 → T3（qwen-max 遵循 JSON schema 显著强于 qwen-plus）
    for await (const chunk of streamDashscopeAPI(planSystemPrompt, planUserPrompt, { hint: { task: "task_generation" } })) {
      planJson += chunk;
      // 不 yield，先收集
    }

    // Step 2: 解析 JSON
    let parsedPlan: any = null;
    try {
      // 提取 JSON（模型可能返回 ```json 包裹的内容）
      const jsonMatch = planJson.match(/\{[^}]+\}/);
      if (jsonMatch) {
        parsedPlan = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      logger.warn("Failed to parse plan JSON, using raw text");
    }

    // 映射 parsedPlan 到 PendingTaskPlan 格式
    function mapDifficulty(diff: string): "easy" | "medium" | "hard" {
      if (diff?.includes("基础") || diff?.includes("简单") || diff?.includes("easy")) return "easy";
      if (diff?.includes("进阶") || diff?.includes("中等") || diff?.includes("medium")) return "medium";
      return "hard";
    }

    function extractPeriodDays(duration: string): number | null {
      const match = duration?.match(/(\d+)\s*[天周]/);
      if (match) return parseInt(match[1]);
      // 如果是"周"，乘以7
      if (duration?.includes("周")) {
        const weekMatch = duration.match(/(\d+)\s*周/);
        if (weekMatch) return parseInt(weekMatch[1]) * 7;
      }
      return 7; // 默认7天
    }

    function extractEstimatedMinutes(practice: string): number {
      // 尝试从 daily_practice 提取时间
      const hourMatch = practice?.match(/(\d+)\s*小时/);
      if (hourMatch) return parseInt(hourMatch[1]) * 60;
      const minMatch = practice?.match(/(\d+)\s*分钟/);
      if (minMatch) return parseInt(minMatch[1]);
      return 60; // 默认60分钟
    }

    const mappedPlan = parsedPlan ? {
      title: parsedPlan.tech_stack || "技术学习计划",
      description: parsedPlan.reason || "技术栈学习计划",
      module: parsedPlan.tech_stack || null,
      difficulty: mapDifficulty(parsedPlan.difficulty),
      estimatedMinutes: extractEstimatedMinutes(parsedPlan.daily_practice),
      dailyQuestionCount: null,
      periodDays: extractPeriodDays(parsedPlan.duration),
      reason: parsedPlan.reason || null,
      rawPlan: planJson,
    } : null;

    // Step 3: 再调用模型，将计划转换成友好文本（这次 yield）
    const explainSystemPrompt = `你是 TechMate 技术学习助手。请用亲切、鼓励的语气向用户介绍学习计划。

回复要求：
1. 使用自然语言，不要输出 JSON
2. 简洁明了，控制在 100 字以内
3. 用表情符号增加亲和力（如 📚、💪、🎯）
4. 结尾提示用户可以确认或调整计划`;

    const explainUserPrompt = parsedPlan
      ? `请用友好语气介绍以下学习计划：
- 技术栈：${parsedPlan.tech_stack}
- 每日练习：${parsedPlan.daily_practice}
- 难度：${parsedPlan.difficulty}
- 预计周期：${parsedPlan.duration}
- 推荐理由：${parsedPlan.reason}`
      : `请用友好语气介绍这个学习计划：${planJson}`;

    // Step 4: yield 友好文本
    let friendlyContent = "";
    for await (const chunk of streamDashscopeAPI(explainSystemPrompt, explainUserPrompt)) {
      friendlyContent += chunk;
      yield chunk;
    }

    const quickReplies = createQuickReplies(["确认计划", "调整任务", "取消"]);
    LogTools.logAgentDecision(state.userId, state.userIntent, "Task generation Stream");

    return {
      ...state,
      messages: [...state.messages, new AIMessage(friendlyContent)],
      quickReplyOptions: quickReplies,
      waitingForUserInput: true,
      pendingTaskPlan: mappedPlan ?? undefined,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Task generation stream failed", err);
    const errorMessage = "抱歉，生成任务计划时出错了。请稍后再试。";
    yield errorMessage;
    
    return {
      ...state,
      messages: [...state.messages, new AIMessage(errorMessage)],
      quickReplyOptions: createQuickReplies(["重试"]),
      waitingForUserInput: true,
    };
  }
}

export async function* progressQueryNodeStream(
  state: GraphStateType
): AsyncGenerator<string, GraphStateType, unknown> {
  logger.info("Progress query stream node executing");

  try {
    const llm = createLLM();
    const lastMessage = state.messages[state.messages.length - 1];
    const content = lastMessage.content as string;

    const contextEnhancer = getContextEnhancer();
    const context = await contextEnhancer.enhanceContext(state.userId, content);

    const systemPrompt = SYSTEM_PROMPTS.GENERAL_QA;
    const userPrompt = `用户ID：${state.userId}\n${contextEnhancer.generateSystemPromptEnhancement(context)}`;

    const stream = await llm.stream([
      new SystemMessage(systemPrompt),
      ...buildLLMMessages(state.messages.slice(0, -1)),
      new HumanMessage(userPrompt),
    ]);

    let fullContent = "";
    for await (const chunk of stream) {
      const chunkContent = chunk.content as string;
      fullContent += chunkContent;
      yield chunkContent;
    }

    LogTools.logAgentDecision(state.userId, state.userIntent, "Progress query Stream");

    return {
      ...state,
      messages: [...state.messages, new AIMessage(fullContent)],
      quickReplyOptions: createQuickReplies(["继续提问", "查看详细进度", "返回首页"]),
      waitingForUserInput: false,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Progress query stream failed", err);
    const errorMessage = "抱歉，查询进度时出错了。请稍后再试。";
    yield errorMessage;

    return {
      ...state,
      messages: [...state.messages, new AIMessage(errorMessage)],
      quickReplyOptions: createQuickReplies(["重试", "返回首页"]),
      waitingForUserInput: false,
    };
  }
}

export async function* emotionSupportNodeStream(
  state: GraphStateType
): AsyncGenerator<string, GraphStateType, unknown> {
  logger.info("Emotion support stream node executing");

  try {
    const llm = createLLM();
    const lastMessage = state.messages[state.messages.length - 1];
    const content = lastMessage.content as string;

    const emotionDetector = getEmotionDetector();
    const emotion = await emotionDetector.detectEmotion(content);

    const systemPrompt = SYSTEM_PROMPTS.EMOTION_SUPPORT;
    const userPrompt = `用户情绪：${emotion.emotion}\n用户消息：${content}`;

    const stream = await llm.stream([
      new SystemMessage(systemPrompt),
      ...buildLLMMessages(state.messages.slice(0, -1)),
      new HumanMessage(userPrompt),
    ]);

    let fullContent = "";
    for await (const chunk of stream) {
      const chunkContent = chunk.content as string;
      fullContent += chunkContent;
      yield chunkContent;
    }

    LogTools.logAgentDecision(state.userId, state.userIntent, "Emotion support Stream");

    return {
      ...state,
      messages: [...state.messages, new AIMessage(fullContent)],
      quickReplyOptions: createQuickReplies(["继续倾诉", "换个话题", "结束对话"]),
      waitingForUserInput: false,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Emotion support stream failed", err);
    const errorMessage = "抱歉，情感支持时出错了。请稍后再试。";
    yield errorMessage;

    return {
      ...state,
      messages: [...state.messages, new AIMessage(errorMessage)],
      quickReplyOptions: createQuickReplies(["重试", "结束对话"]),
      waitingForUserInput: false,
    };
  }
}
