/**
 * 四层记忆融合检索器
 *
 * 大白话解释：
 * 就像回忆一件事，你会结合：
 * - 当前正在想的（瞬时）
 * - 最近发生的（短期）
 * - 以前学过的（长期）
 * - 自己的性格习惯（元）
 * 来综合判断。
 */

import {
  getShortTermMemoryRepository,
  getMetaMemoryRepository,
  getUserRepository,
} from "@tech-mate/database";
import {
  getInstantMemoryManager,
  getLongMemoryArchiver,
  getMetaMemoryAggregator,
  type Message,
  type InstantMemorySlice,
} from "./index";
import { withSpan } from "../otel/instrumentation";

export interface FusedMemoryContext {
  instant: InstantMemorySlice;
  short: any[];
  long: any[];
  meta: any;
  fusedContext: string;
}

export class MemoryFusionRetriever {
  /**
   * 四层记忆融合检索
   *
   * 技术流程：
   * 1. 瞬时记忆：当前对话最近的 N 条消息（滑动窗口）
   * 2. 短期记忆：按新鲜度排序的近期话题（7天内）
   * 3. 长期记忆：向量相似检索（权重加权）
   * 4. 元记忆：用户画像和能力图谱
   * 5. 融合：按权重拼接上下文，提供给 Agent
   */
  async retrieve(userId: string, query: string, messages: Message[]): Promise<FusedMemoryContext> {
    // 父 span：整个四阶融合可在 Trace Viewer 瀑布图回溯（与 guardrail/rag span 同套机制，
    // withSpan 无 trace 上下文时自动降级直跑，纯观测、零行为风险）。
    return withSpan(
      "memory.fusion",
      async (fusionSpan) => {
        console.log("[Memory] 开始四层记忆融合检索");
        console.log(`[Memory] 用户: ${userId}`);
        console.log(`[Memory] 查询: "${query.slice(0, 50)}..."`);

        // 1-4: 四个 retriever 独立、无依赖，全部并行检索；各自一个子 span，
        // 瀑布图能看清四阶各自真实延迟（瞬时≈0ms / 短期·元 SQLite / 长期 Chroma 通常是瓶颈）
        const t0 = Date.now();
        const [instantMemory, shortMemory, longMemory, metaMemory] = await Promise.all([
          withSpan("memory.instant", async (s) => {
            const r = await this.getInstantMemory(messages);
            s?.setAttributes({ messages: r.messages.length, tokens: r.tokenCount });
            return r;
          }),
          withSpan("memory.short", async (s) => {
            const r = await this.getShortMemory(userId, query);
            s?.setAttributes({ count: r.length, topFreshness: r[0]?.freshnessScore ?? null });
            return r;
          }),
          withSpan("memory.long", async (s) => {
            const r = await this.getLongMemory(userId, query);
            s?.setAttributes({ count: r.length, topScore: r[0]?.score ?? null });
            return r;
          }),
          withSpan("memory.meta", async (s) => {
            const r = await this.getMetaMemory(userId);
            s?.setAttributes({
              strong: (r.strongAreas || []).length,
              weak: (r.weakAreas || []).length,
              learningStyle: r.learningStyle || "未知",
              hasNickname: !!r.nickname,
            });
            return r;
          }),
        ]);
        const parallelMs = Date.now() - t0;
        console.log(`[Memory] 4 路并行检索完成 ${parallelMs}ms`);
        console.log(`[Memory] 瞬时记忆: ${instantMemory.messages.length} 条消息`);
        console.log(`[Memory] 短期记忆: ${shortMemory.length} 条相关记忆`);
        shortMemory.slice(0, 3).forEach((m: any) => {
          console.log(`  - ${m.topicTags || "无话题"}: 新鲜度=${(m.freshnessScore || 0).toFixed(2)}`);
        });
        console.log(`[Memory] 长期记忆: ${longMemory.length} 条相关经验`);
        longMemory.slice(0, 3).forEach((m: any) => {
          console.log(`  - 权重=${(m.metadata?.weight || 0).toFixed(2)}, 分数=${m.score.toFixed(2)}`);
        });
        console.log(`[Memory] 元记忆: 强项=${metaMemory.strongAreas?.join(",") || "暂无"}, 弱项=${metaMemory.weakAreas?.join(",") || "暂无"}`);
        console.log(`[Memory] 元记忆: 学习风格=${metaMemory.learningStyle || "未知"}, 连续学习=${metaMemory.consecutiveDays || 0}天`);

        // 5. 融合：按权重拼接上下文
        const fusedContext = this.fuseContexts(instantMemory, shortMemory, longMemory, metaMemory);
        console.log(`[Memory] 融合后上下文长度: ${fusedContext.length} 字符`);

        fusionSpan?.setAttributes({
          instant: instantMemory.messages.length,
          short: shortMemory.length,
          long: longMemory.length,
          metaStrong: (metaMemory.strongAreas || []).length,
          metaWeak: (metaMemory.weakAreas || []).length,
          fusedLength: fusedContext.length,
          parallelMs,
        });

        return {
          instant: instantMemory,
          short: shortMemory,
          long: longMemory,
          meta: metaMemory,
          fusedContext,
        };
      },
      { userId, queryLength: query.length }
    );
  }

  /**
   * 获取瞬时记忆（滑动窗口裁剪）
   */
  private async getInstantMemory(messages: Message[]): Promise<InstantMemorySlice> {
    const manager = getInstantMemoryManager();
    return manager.trimMessages(messages);
  }

  /**
   * 获取短期记忆（新鲜度排序）
   */
  private async getShortMemory(userId: string, query: string): Promise<any[]> {
    try {
      const repo = getShortTermMemoryRepository();
      const memories = await repo.findActiveByUserId(userId, 10);

      // 按新鲜度排序
      return memories.sort((a: any, b: any) => b.freshnessScore - a.freshnessScore);
    } catch (error) {
      console.error("[Memory] 短期记忆获取失败:", error);
      return [];
    }
  }

  /**
   * 获取长期记忆（向量相似检索 + 权重加权）
   */
  private async getLongMemory(userId: string, query: string): Promise<any[]> {
    try {
      const archiver = getLongMemoryArchiver();
      return await archiver.search(userId, query, 5);
    } catch (error) {
      console.error("[Memory] 长期记忆获取失败:", error);
      return [];
    }
  }

  /**
   * 获取元记忆（用户画像）
   *
   * 额外读取 UserProfile.nickname —— 这是用户跨会话的"身份"，
   * 必须放进 fusedContext 让 LLM 看到，否则用户刷新一次就被遗忘。
   */
  private async getMetaMemory(userId: string): Promise<any> {
    try {
      const aggregator = getMetaMemoryAggregator();
      const summary = await aggregator.getSummary(userId);

      // 解析摘要获取结构化数据
      const repo = getMetaMemoryRepository();
      const meta = await repo.findByUserId(userId);

      // 读取用户昵称（跨会话身份）
      let nickname: string | null = null;
      try {
        const userRepo = getUserRepository();
        const profile = await userRepo.getUserProfile(userId);
        // 过滤默认值"学习者"——它不是用户真名
        if (profile?.nickname && profile.nickname !== "学习者") {
          nickname = profile.nickname;
        }
      } catch (e) {
        console.warn("[Memory] 读取 nickname 失败", e);
      }

      if (meta) {
        return {
          summary,
          nickname,
          strongAreas: JSON.parse(meta.strongAreas || "[]"),
          weakAreas: JSON.parse(meta.weakAreas || "[]"),
          learningStyle: meta.learningStyle,
          consecutiveDays: meta.consecutiveDays,
          averageAccuracy: meta.averageAccuracy,
        };
      }

      // 如果没有元记忆，返回默认值
      return {
        summary,
        nickname,
        strongAreas: [],
        weakAreas: [],
        learningStyle: null,
        consecutiveDays: 0,
        averageAccuracy: 0,
      };
    } catch (error) {
      console.error("[Memory] 元记忆获取失败:", error);
      return {
        summary: "",
        nickname: null,
        strongAreas: [],
        weakAreas: [],
        learningStyle: null,
        consecutiveDays: 0,
        averageAccuracy: 0,
      };
    }
  }

  /**
   * 融合上下文
   *
   * 技术原理：
   * 按权重拼接各层记忆，构建 Agent 能理解的上下文：
   * - 元记忆作为系统提示的一部分（用户画像）
   * - 长期记忆作为知识背景（相关经验）
   * - 短期记忆作为近期话题（topic 标签摘要）
   * 注：瞬时记忆（当前对话原文）**不再**进此块——已在 LLM message 历史里，
   *     重复注入会拔高旧话题导致串话，故 _instant 仅占位不序列化。
   */
  private fuseContexts(
    _instant: InstantMemorySlice,
    short: any[],
    long: any[],
    meta: any
  ): string {
    let context = "";

    // 用户身份（跨会话的核心信息，放最前面让 LLM 一眼看到）
    if (meta.nickname) {
      context += `【用户称呼】${meta.nickname}（请使用此称呼与用户交流；用户已自报姓名，不要忽略）\n\n`;
    }

    // 元记忆作为系统提示的一部分
    if (meta.summary) {
      context += meta.summary + "\n\n";
    }

    // 长期记忆作为知识背景
    if (long.length > 0) {
      context += "【相关经验】\n";
      long.slice(0, 3).forEach((m: any) => {
        context += `- ${m.content?.slice(0, 100) || "无内容"}\n`;
      });
      context += "\n";
    }

    // 短期记忆 → 只给"聊过哪些话题"的**标签**，绝不带原文片段。
    // 串话修复(2026-05)：原来每条还带 content.slice(50) 原文，turn1 闭包问答
    // 被持久化进短期记忆后，turn2 又把闭包原文回灌进 🧠 块 → 串话残留通道之一。
    // 标签(如"闭包、React")用于个性化足够；原文是 message 历史的职责，不在此重复。
    if (short.length > 0) {
      const tags = Array.from(
        new Set(
          short
            .slice(0, 5)
            .flatMap((m: any) => (m.topicTags ? JSON.parse(m.topicTags) : []))
        )
      ).filter(Boolean);
      if (tags.length > 0) {
        context += `【近期聊过的话题（仅供个性化参考，不是本轮主题来源）】${tags.join("、")}\n\n`;
      }
    }

    // ⚠️ 串话修复（2026-05）：不再把 instant 最近消息原文塞进 fusedContext。
    // 原因：那些消息已在 LLM message 数组(historyForLLM)里、由 buildAnswerRules
    // 第1条管辖；再复制进 system prompt 的"🧠 对话记忆"块 = 重复 + 把上一轮
    // 旧话题正文拔高成"记忆/画像"，prominence 盖过当前问题与检索证据，导致
    // "问 LangGraph 答上一轮闭包"的串话。当前对话内容由 message 历史承载，
    // 记忆块只保留跨会话画像/事实/话题标签，不复读原文。
    // （已核验：generalQANode 未用 fusedContext；stream 路径另传 history，安全）

    return context;
  }
}

// 单例实例
let retriever: MemoryFusionRetriever | null = null;

export function getMemoryFusionRetriever(): MemoryFusionRetriever {
  if (!retriever) {
    retriever = new MemoryFusionRetriever();
  }
  return retriever;
}
