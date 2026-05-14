/**
 * 图构建 - StateGraph 实现
 * LangGraph 状态机的图构建
 *
 * 改造说明：
 * - 从手动 switch-case 编排改为标准 StateGraph
 * - edges.ts 中定义的路由函数现在被真正使用
 */

import { logger } from "@tech-mate/core";
import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph/checkpoint/sqlite";
import * as fs from "fs";
import * as path from "path";
import type { GraphStateType } from "./state";
import { graphStateChannels, createInitialState } from "./state";
import {
  intentRecognitionNode,
  taskGenerationNode,
  progressQueryNode,
  emotionSupportNode,
  generalQANode,
  generateResponseNode,
  generalQANodeStream,
  StreamChunk,
  streamDashscopeAPIWithThinking,
  shouldClarifyTaskPlan,
  buildClarificationMessage,
  createQuickReplies,
} from "./nodes";
import { AIMessage } from "@langchain/core/messages";

/**
 * 创建 LangGraph checkpoint saver。
 *
 * 默认走 SQLite 落盘（真持久化），目录可由 env LANGGRAPH_CHECKPOINT_PATH 指定。
 * 缺省路径跟 Prisma 同目录（packages/web/data/）便于一起备份。
 *
 * 失败兜底：better-sqlite3 native binding 跑不起来时（极少见，主要发生在
 * cross-arch 构建产物未重编译的场景）回落到 MemorySaver，保证 Agent 仍可启动。
 */
function createCheckpointer() {
  try {
    const dbPath = process.env.LANGGRAPH_CHECKPOINT_PATH
      || path.resolve(process.cwd(), "data/langgraph-checkpoints.db");
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const saver = SqliteSaver.fromConnString(dbPath);
    // 触发 setup() 建表（SqliteSaver 把 setup 设为 lazy，但流式路径不会主动 invoke
    // app.invoke()，导致 checkpoints 表迟迟不创建）—— 这里发一次 getTuple 强制建表
    void saver.getTuple({ configurable: { thread_id: "_init" } }).catch(() => {});
    logger.info(`[Checkpoint] SqliteSaver enabled at ${dbPath}`);
    return saver;
  } catch (err) {
    logger.warn(`[Checkpoint] SqliteSaver init failed, falling back to MemorySaver: ${err instanceof Error ? err.message : String(err)}`);
    return new MemorySaver();
  }
}
import { parseTaskPlanFromText } from "./task-plan";
import { SYSTEM_PROMPTS } from "../prompts/system-prompts";
import { TASK_PROMPTS } from "../prompts/task-prompts";
import { routeByIntent } from "./edges";
import { getAgentConfig, validateAgentConfig } from "../config/agent.config";
import { logAgentEvent } from "../utils/event-logger";

/**
 * 把任务规划节点返回的 JSON（或中文 key:value）渲染成 markdown 表格
 *
 * 兼容三种输入：
 * 1. 严格 JSON: {"tech_stack":"React","daily_practice":"每天3个","difficulty":"基础","duration":"7天","reason":"..."}
 * 2. JSON 被 ```json 包裹
 * 3. 中文 key:value（"技术栈：xxx\n练习量：xxx"）
 */
function formatTaskPlanAsMarkdown(raw: string): string {
  const header = "## 📋 为你定制的学习计划";
  const footer = "> 如需调整，请使用下方快捷按钮。";
  const safe = (v: any) => (v == null ? "—" : String(v).trim() || "—");

  // 1) 尝试提取 JSON
  let parsed: Record<string, any> | null = null;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      parsed = null;
    }
  }

  if (parsed) {
    const tech = safe(parsed.tech_stack || parsed.techStack || parsed.module || parsed.技术栈);
    const practice = safe(parsed.daily_practice || parsed.dailyPractice || parsed.practice || parsed.练习量);
    const difficulty = safe(parsed.difficulty || parsed.难度);
    const duration = safe(parsed.duration || parsed.period || parsed.周期);
    const reason = safe(parsed.reason || parsed.说明 || parsed.理由);
    const path: any[] = Array.isArray(parsed.learning_path) ? parsed.learning_path : (Array.isArray(parsed.阶段) ? parsed.阶段 : []);
    const resources: any[] = Array.isArray(parsed.resources) ? parsed.resources : (Array.isArray(parsed.推荐资料) ? parsed.推荐资料 : []);

    // bullet 列表替代 markdown 表格——qwen 流式输出经常把表格行挤碎，bullet 列表每行独立更稳
    const parts: string[] = [
      header,
      "",
      `- **🎯 技术栈**：${tech}`,
      `- **📝 练习量**：${practice}`,
      `- **📊 难度**：${difficulty}`,
      `- **⏳ 周期**：${duration}`,
      "",
    ];

    if (path.length > 0) {
      parts.push("### 🗺️ 学习路径");
      path.forEach((p, i) => parts.push(`${i + 1}. ${String(p).trim()}`));
      parts.push("");
    }

    if (resources.length > 0) {
      parts.push("### 📚 推荐资料");
      resources.forEach((r) => parts.push(`- ${String(r).trim()}`));
      parts.push("");
    }

    if (reason && reason !== "—") {
      parts.push(`**为什么选这个？** ${reason}`);
      parts.push("");
    }
    parts.push(footer);

    return parts.join("\n");
  }

  // 2) 中文 key:value 兜底（去掉可能的 JSON 残余后保留行）
  const lines = cleaned.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  return [header, "", ...lines, "", footer].join("\n");
}

/**
 * 创建 Agent StateGraph
 *
 * 结构：
 * - START → intent_recognition
 * - intent_recognition → 根据意图分发到各业务节点（条件边）
 * - 各业务节点 → generate_response → END
 * - 状态在每个节点之间自动累积传递
 */
export function createAgentGraph() {
  logger.info("Creating agent graph with StateGraph");

  const config = getAgentConfig();
  validateAgentConfig(config);

  // ========== 创建 StateGraph workflow ==========
  // 注意：分步调用以正确推断 TypeScript 类型
  const workflow = new StateGraph<GraphStateType>({ channels: graphStateChannels });

  // ========== 添加节点（地铁站）==========
  workflow.addNode("intent_recognition", intentRecognitionNode);
  workflow.addNode("task_generation", taskGenerationNode);
  workflow.addNode("progress_query", progressQueryNode);
  workflow.addNode("emotion_support", emotionSupportNode);
  workflow.addNode("general_qa", generalQANode);
  workflow.addNode("generate_response", generateResponseNode);

  // ========== 添加边（地铁线路）==========
  // 固定边：START → intent_recognition
  workflow.addEdge(START, "intent_recognition" as any);

  // 条件边：intent_recognition → 根据意图路由
  // routeByIntent 返回节点名称，StateGraph 自动传递状态到对应节点
  // 注意：不传 pathMap，让 StateGraph 根据路由函数返回值决定
  workflow.addConditionalEdges("intent_recognition" as any, routeByIntent);

  // 固定边：所有意图节点 → generate_response
  workflow.addEdge("task_generation" as any, "generate_response" as any);
  workflow.addEdge("progress_query" as any, "generate_response" as any);
  workflow.addEdge("emotion_support" as any, "generate_response" as any);
  workflow.addEdge("general_qa" as any, "generate_response" as any);

  // 固定边：generate_response → END
  workflow.addEdge("generate_response" as any, END);

  // ========== 编译 Graph：持久化 checkpoint ==========
  // SqliteSaver 落盘每个 thread (conversation_id) 的 state 快照，进程重启不丢；
  // 旧实现是 MemorySaver（仅内存），不算真持久化
  //
  // env LANGGRAPH_CHECKPOINT_PATH 可覆盖；缺省走 packages/web/data 下，
  // 跟 Prisma SQLite 同目录便于一起备份
  const checkpointer = createCheckpointer();
  const app = workflow.compile({ checkpointer });

  logger.info("Agent graph created successfully with StateGraph");

  return {
    /**
     * 非流式执行（兼容现有接口）
     */
    processState: async (state: GraphStateType): Promise<GraphStateType> => {
      const result = await app.invoke(state, {
        configurable: { thread_id: `session-${state.userId}-${Date.now()}` },
      });
      return result as GraphStateType;
    },

    /**
     * 流式执行（支持真正的逐字符流式输出 + 思考过程）
     *
     * 实现原理：
     * 1. 先执行意图识别（非流式）
     * 2. 根据意图选择对应的流式节点
     * 3. 直接调用流式节点，逐字符 yield
     *
     * 返回类型：StreamChunk = { type: "thought" | "content"; text: string }
     * - thought: 思考过程（灰色背景区域）
     * - content: 正式回答
     */
    processStateStream: async function* (
      state: GraphStateType
    ): AsyncGenerator<StreamChunk, GraphStateType, unknown> {
      // ========== LangGraph 持久化：每次 turn 写一条 checkpoint ==========
      // 流式路径手动 dispatch 节点，没走 app.invoke 的自动 checkpoint 链；
      // 这里在 turn 起点显式 updateState 一次，让 SqliteSaver 把当前 thread
      // 的 state 落盘。thread_id 用 userId（GraphStateType 没暴露 conversationId
      // 字段；如果以后改了 state 形状，这里可以切到更细的 thread 粒度）。
      const threadId = `user-${state.userId}`;
      try {
        await app.updateState(
          { configurable: { thread_id: threadId } },
          state
        );
      } catch (err) {
        // SqliteSaver 写入失败不应该 break chat —— 仅记录
        logger.warn(`[Checkpoint] updateState failed (thread=${threadId}): ${err instanceof Error ? err.message : String(err)}`);
      }

      // ========== Step: 意图识别 ==========
      const intentT0 = Date.now();
      yield {
        type: "step",
        text: "",
        stepId: "intent",
        stepLabel: "意图识别",
        stepIcon: "🎯",
        stepStatus: "running",
      };

      const intentResult = await intentRecognitionNode(state);
      const currentState: GraphStateType = {
        ...state,
        ...intentResult,
        userId: state.userId,
        messages: intentResult.messages
          ? [...state.messages, ...intentResult.messages]
          : state.messages,
        userIntent: intentResult.userIntent || state.userIntent,
        intentDecision: intentResult.intentDecision || state.intentDecision,
        waitingForUserInput: intentResult.waitingForUserInput ?? state.waitingForUserInput,
        quickReplyOptions: intentResult.quickReplyOptions || state.quickReplyOptions,
        ragResults: intentResult.ragResults || state.ragResults,
        feishuTaskIds: intentResult.feishuTaskIds || state.feishuTaskIds,
      };

      const intent = currentState.userIntent;
      logger.info(`Stream routing by intent: ${intent}`);

      // 意图友好名称映射
      const intentLabels: Record<string, string> = {
        create_task: "制定学习计划",
        progress_tracking: "查询学习进度",
        emotional_support: "情绪支持",
        general_inquiry: "通用问答",
      };

      // 拼出更详细的 detail：意图 + 理由 + 关键词 + 耗时
      const decision = currentState.intentDecision;
      const intentLabel = intentLabels[intent] || intent;
      const detailParts: string[] = [intentLabel];
      if (decision?.reasoning) detailParts.push(decision.reasoning);
      if (decision?.keywords && decision.keywords.length > 0) {
        detailParts.push(`关键词：${decision.keywords.join("、")}`);
      }
      detailParts.push(`${Date.now() - intentT0}ms`);

      yield {
        type: "step",
        text: "",
        stepId: "intent",
        stepLabel: "意图识别",
        stepIcon: "🎯",
        stepStatus: "done",
        stepDetail: detailParts.join(" · "),
      };

      // 埋点：意图识别完成
      logAgentEvent({
        userId: state.userId,
        eventType: "intent",
        eventName: intent,
        payload: {
          intentLabel,
          reasoning: decision?.reasoning,
          keywords: decision?.keywords,
        },
        durationMs: Date.now() - intentT0,
      });

      // Step 2: 根据意图选择流式节点
      const nodeT0 = Date.now();
      try {
        if (intent === "create_task") {
          // === Step 1: 需求确认（纯本地判断，不调 LLM）===
          const checkT0 = Date.now();
          yield {
            type: "step",
            text: "",
            stepId: "clarify",
            stepLabel: "需求确认",
            stepIcon: "❓",
            stepStatus: "running",
          };

          const { needClarify } = shouldClarifyTaskPlan(currentState);

          // 分支 1：信息不足 → 直接追问（不走 LLM，毫秒级）
          if (needClarify) {
            const clarifyContent = buildClarificationMessage();
            yield {
              type: "step",
              text: "",
              stepId: "clarify",
              stepLabel: "需求确认",
              stepIcon: "❓",
              stepStatus: "done",
              stepDetail: `信息不充足，发起追问 · ${Date.now() - checkT0}ms`,
            };
            yield { type: "content", text: clarifyContent };
            return {
              ...currentState,
              messages: [...currentState.messages, new AIMessage(clarifyContent)],
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
            } as GraphStateType;
          }

          // 分支 2：信息充足 → 流式生成完整计划
          yield {
            type: "step",
            text: "",
            stepId: "clarify",
            stepLabel: "需求确认",
            stepIcon: "❓",
            stepStatus: "done",
            stepDetail: `需求明确 · ${Date.now() - checkT0}ms`,
          };

          // 检测"调整 vs 新建"
          const isAdjustment = currentState.messages.some((m: any) => {
            const role = m.role || (m._getType ? m._getType() : "");
            const c = typeof m.content === "string" ? m.content : "";
            return (role === "assistant" || role === "ai") && (c.includes("📋") || c.includes("学习计划"));
          });

          // 提取上一份计划（调整场景）
          let previousPlan: string | null = null;
          for (let i = currentState.messages.length - 2; i >= 0; i--) {
            const msg: any = currentState.messages[i];
            const role = msg.role || (msg._getType ? msg._getType() : "");
            const c = typeof msg.content === "string" ? msg.content : "";
            if ((role === "assistant" || role === "ai") && (c.includes("学习计划") || c.includes("📋"))) {
              previousPlan = c;
              break;
            }
          }

          // 用户当前需求
          const lastUserMessage = [...currentState.messages].reverse().find((m: any) => {
            const r = m.role || (m._getType ? m._getType() : "");
            return r === "user" || r === "human";
          });
          const userRequest = typeof lastUserMessage?.content === "string"
            ? lastUserMessage.content
            : "用户想学习技术";

          // === Step 2: 流式生成（边出字边收集 + 解析）===
          const genT0 = Date.now();
          yield {
            type: "step",
            text: "",
            stepId: "generate",
            stepLabel: "生成学习计划",
            stepIcon: "🎯",
            stepStatus: "running",
            stepDetail: isAdjustment ? "基于上一份计划调整中..." : "正在为你定制...",
          };

          const systemPrompt = SYSTEM_PROMPTS.TASK_GENERATION;
          // 用 markdown 版 prompt：LLM 直接输出表格，跳过 JSON 中间形态
          // 配合下游 parseTaskPlanFromText 已经识别 markdown 表格
          const promptBase = TASK_PROMPTS.GENERATE_TASK_PLAN_MARKDOWN
            .replace("{userId}", currentState.userId)
            .replace("{progress}", "暂无进度数据")
            .replace("{weakModules}", "待分析")
            .replace("{studyHabits}", "待分析");
          const adjustmentContext = previousPlan
            ? `\n上一份计划：\n${previousPlan}\n\n请基于上一份计划做有针对性的调整（不要重复输出一遍）。\n`
            : "";
          const fullUserPrompt = `用户具体需求：${userRequest}${adjustmentContext}\n\n${promptBase}`;

          let fullContent = "";
          // 任务计划生成（含 markdown 结构化输出）→ T3
          for await (const chunk of streamDashscopeAPIWithThinking(systemPrompt, fullUserPrompt, { hint: { task: "task_generation" } })) {
            if (chunk.type === "content") {
              fullContent += chunk.text;
              yield chunk;
            } else if (chunk.type === "thought") {
              yield chunk;
            }
          }

          yield {
            type: "step",
            text: "",
            stepId: "generate",
            stepLabel: "生成学习计划",
            stepIcon: "🎯",
            stepStatus: "done",
            stepDetail: `${fullContent.length} 字 · ${Date.now() - genT0}ms`,
          };

          // 解析 + 写入 pendingTaskPlan（任务页联动的关键）
          const parsedPlan = parseTaskPlanFromText(fullContent);

          logAgentEvent({
            userId: state.userId,
            eventType: "node",
            eventName: "task_generation",
            payload: {
              isAdjustment,
              planLength: fullContent.length,
              parsed: !!parsedPlan,
              periodDays: parsedPlan?.periodDays,
              module: parsedPlan?.module,
            },
            durationMs: Date.now() - nodeT0,
          });

          return {
            ...currentState,
            messages: [...currentState.messages, new AIMessage(fullContent)],
            quickReplyOptions: createQuickReplies(["确认计划", "调整任务", "取消"]),
            waitingForUserInput: true,
            pendingTaskPlan: parsedPlan ?? undefined,
          } as GraphStateType;
        } else if (intent === "progress_tracking") {
          const result = await progressQueryNode(currentState);
          if (result.messages?.length) {
            const lastMessage = result.messages[result.messages.length - 1];
            if (lastMessage?.content) {
              yield { type: "content", text: lastMessage.content as string };
            }
          }
          logAgentEvent({
            userId: state.userId,
            eventType: "node",
            eventName: "progress_query",
            durationMs: Date.now() - nodeT0,
          });
          return { ...currentState, ...result } as GraphStateType;
        } else if (intent === "emotional_support") {
          const result = await emotionSupportNode(currentState);
          if (result.messages?.length) {
            const lastMessage = result.messages[result.messages.length - 1];
            if (lastMessage?.content) {
              yield { type: "content", text: lastMessage.content as string };
            }
          }
          logAgentEvent({
            userId: state.userId,
            eventType: "node",
            eventName: "emotion_support",
            durationMs: Date.now() - nodeT0,
          });
          return { ...currentState, ...result } as GraphStateType;
        } else {
          // 默认（包括 general_inquiry）使用通用问答流式
          const streamGenerator = generalQANodeStream(currentState);

          // 关键：用 next() 显式捕获 generator 的 return value
          // for-await-of 会丢失 return value，导致 usedSources/ragResults 等字段无法回传到 finalState
          let nodeResult: any = null;
          while (true) {
            const r = await streamGenerator.next();
            if (r.done) {
              nodeResult = r.value;
              break;
            }
            yield r.value;
          }

          logAgentEvent({
            userId: state.userId,
            eventType: "node",
            eventName: "general_qa",
            payload: {
              sourcesCount: nodeResult?.usedSources?.length || 0,
              ragResultsCount: nodeResult?.ragResults?.length || 0,
            },
            durationMs: Date.now() - nodeT0,
          });

          return { ...currentState, ...(nodeResult || {}) } as GraphStateType;
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error("Stream processing error:", err);
        yield { type: "content", text: "抱歉，处理您的消息时出现了错误。请稍后再试。" };
        return currentState;
      }
    },

    /**
     * 直接访问编译后的 Graph（新增）
     * 用于可视化、调试等
     */
    app,

    /**
     * Workflow 定义（新增）
     * 用于外部可视化 / 调试 Graph 结构
     */
    workflow,
  };
}

/**
 * 导出 createInitialState（兼容现有接口）
 */
export { createInitialState };