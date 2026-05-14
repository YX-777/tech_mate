/**
 * 长期记忆归档器
 *
 * 大白话解释：
 * 就像你真正学会的知识，虽然过去很久但随时能用。
 * 我们把短期记忆中衰减到阈值以下的内容，提取精华，转化为向量永久存储。
 */

import {
  getShortTermMemoryRepository,
  getVectorDBService,
  getEmbeddingService,
} from "@tech-mate/database";
import type { ShortMemory } from "./short";

export interface LongMemoryMetadata {
  user_id: string;
  memory_id: string;
  content_type: string;
  weight: number;          // 重要性权重 0-1
  creation_date: string;
  last_accessed: string;
  access_count: number;
  topics: string[];
  source_conversation: string;
}

export interface ArchiveResult {
  memoryId: string;
  vectorId: string;
  initialWeight: number;
}

/** 检索命中一次的权重强化量（小步长，多次命中渐进逼近 1.0） */
export const RETRIEVAL_BOOST = 0.05;

/**
 * 权重强化纯函数 —— **单一来源**，封顶 1.0。
 * 追踪评分的核心数学：被召回越多 → 权重越高（封顶），证明越有用越不易遗忘。
 */
export function nextWeight(current: number | undefined, boost: number, cap = 1.0): number {
  return Math.min((current ?? 0.5) + boost, cap);
}

export class LongMemoryArchiver {
  private COLLECTION_NAME = "long_term_memory";

  /**
   * 归档短期记忆到长期记忆
   *
   * 技术流程：
   * 1. 查询需要归档的短期记忆（新鲜度低于阈值）
   * 2. 提取精华内容（可选：LLM 摘要）
   * 3. 生成 embedding 向量
   * 4. 计算初始权重（基于访问次数）
   * 5. 存入 ChromaDB
   * 6. 标记短期记忆为已归档
   */
  async archiveFromShortTerm(userId: string): Promise<ArchiveResult[]> {
    console.log(`[LongMemory] 开始归档短期记忆，用户: ${userId}`);

    const shortRepo = getShortTermMemoryRepository();
    const vectorService = getVectorDBService();
    const embeddingService = getEmbeddingService();

    // 1. 查询需要归档的记忆
    const toArchive = await shortRepo.findExpired(userId, 0.1);
    console.log(`[LongMemory] 待归档记忆数: ${toArchive.length}`);

    if (toArchive.length === 0) {
      console.log("[LongMemory] 无需归档的记忆");
      return [];
    }

    const results: ArchiveResult[] = [];

    for (const memory of toArchive) {
      try {
        // 2. 提取精华内容
        const essence = await this.extractEssence(memory);
        console.log(`  - 记忆 ${memory.id}: "${essence.slice(0, 50)}..."`);

        // 3. 生成 embedding
        const vector = await embeddingService.generateEmbedding(essence);

        // 4. 计算初始权重（基于访问次数）
        const initialWeight = Math.min(memory.accessCount * 0.05, 1.0);
        console.log(`    - 初始权重: ${initialWeight.toFixed(2)} (访问次数: ${memory.accessCount})`);

        // 5. 存入 ChromaDB
        const vectorId = `lm_${memory.id}`;
        const metadata: LongMemoryMetadata = {
          user_id: userId,
          memory_id: memory.id,
          content_type: memory.contentType,
          weight: initialWeight,
          creation_date: new Date().toISOString(),
          last_accessed: new Date().toISOString(),
          access_count: memory.accessCount,
          topics: memory.topicTags ? JSON.parse(memory.topicTags) : [],
          source_conversation: memory.conversationId,
        };

        await vectorService.addEmbedding(
          this.COLLECTION_NAME,
          vectorId,
          vector,
          metadata as any
        );
        console.log(`    - 向量存储成功: ${vectorId}`);

        // 6. 标记短期记忆为已归档
        await shortRepo.markArchived(memory.id);

        results.push({
          memoryId: memory.id,
          vectorId,
          initialWeight,
        });
      } catch (error) {
        console.error(`[LongMemory] 归档失败: ${memory.id}`, error);
      }
    }

    console.log(`[LongMemory] 归档完成，成功: ${results.length} 条`);

    return results;
  }

  /**
   * 提取精华内容
   *
   * 技术原理：
   * 简单版：直接使用原内容
   * 进阶版：调用 LLM 摘要关键信息
   */
  async extractEssence(memory: any): Promise<string> {
    // 简单版：直接使用内容
    return memory.content;

    // 进阶版（未来可扩展）：
    // const llmSummary = await this.llm.summarize(memory.content);
    // return llmSummary;
  }

  /**
   * 强化长期记忆权重
   *
   * 强化触发：
   * 1. 检索命中 → +0.10 权重
   * 2. 话题匹配 → +0.15 权重
   * 3. 用户明确说重要 → +0.30 权重
   */
  async reinforceWeight(vectorId: string, boost: number): Promise<void> {
    console.log(`[LongMemory] 强化权重: ${vectorId}, 增量: +${boost.toFixed(2)}`);

    const vectorService = getVectorDBService();

    // 获取现有向量数据
    const existing = await vectorService.get(this.COLLECTION_NAME, vectorId);
    if (!existing) {
      console.error(`[LongMemory] 向量不存在: ${vectorId}`);
      return;
    }

    // 更新权重（上限 1.0，复用单一来源 nextWeight）
    const currentWeight = existing.metadata?.weight || 0.5;
    const newWeight = nextWeight(currentWeight, boost);

    // 更新 metadata
    await vectorService.updateEmbedding(
      this.COLLECTION_NAME,
      vectorId,
      existing.vector,
      {
        ...existing.metadata,
        weight: newWeight,
        access_count: (existing.metadata?.access_count || 0) + 1,
        last_accessed: new Date().toISOString(),
      }
    );

    console.log(`  - 权重更新: ${currentWeight.toFixed(2)} → ${newWeight.toFixed(2)}`);
  }

  /**
   * 批量强化检索命中的记忆（追踪评分入口）。
   * 串行逐条 best-effort：单条失败不影响其余，整体由 search() 以
   * 非阻塞方式调用，不拖慢检索返回。
   */
  private async reinforceHits(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (!id) continue;
      try {
        await this.reinforceWeight(id, RETRIEVAL_BOOST);
      } catch (e) {
        console.warn(`[LongMemory] 命中强化失败 ${id}:`, e);
      }
    }
  }

  /**
   * 检索长期记忆（权重加权）
   *
   * 技术原理：
   * 1. 向量相似检索
   * 2. 权重加权排序
   * 最终分数 = 相似度 × 权重
   */
  async search(userId: string, query: string, topK: number = 5): Promise<{
    content: string;
    score: number;
    metadata: LongMemoryMetadata;
  }[]> {
    console.log(`[LongMemory] 搜索: "${query.slice(0, 50)}..."`);

    try {
      const embeddingService = getEmbeddingService();
      const vectorService = getVectorDBService();

      // 生成查询向量
      const queryVector = await embeddingService.generateEmbedding(query);

      // ChromaDB 搜索
      const results = await vectorService.search(
        this.COLLECTION_NAME,
        queryVector,
        topK * 2, // 取更多结果，后面按权重排序
        { user_id: userId }
      );

      // 权重加权排序（内部保留 id 供命中强化用）
      const weightedResults = results.map((r: any) => {
        const similarity = 1 - (r.distance || 0);
        const weight = r.metadata?.weight || 0.5;
        const finalScore = similarity * weight;

        console.log(`  - ${r.id}: 相似度=${similarity.toFixed(2)}, 权重=${weight.toFixed(2)}, 最终=${finalScore.toFixed(2)}`);

        return {
          id: r.id as string,
          content: r.content || r.metadata?.content || "",
          score: finalScore,
          metadata: r.metadata as LongMemoryMetadata,
        };
      }).sort((a, b) => b.score - a.score);

      const topResults = weightedResults.slice(0, topK);

      // ===== 追踪评分：被检索命中 = 证明有用 → 强化权重 =====
      // 异步 best-effort，**不 await、不阻塞检索返回**（memory.long 是延迟瓶颈，
      // 强化是写后台不能拖慢主链路）；失败静默吞掉，绝不影响本次回答。
      // 复用死代码 reinforceWeight + 单一来源 nextWeight，让"追踪评分"真正成立。
      this.reinforceHits(topResults.map((r) => r.id)).catch(() => {});

      // 返回 topK（去掉内部 id，对外形状不变）
      return topResults.map(({ id, ...rest }) => rest);
    } catch (error) {
      // ChromaDB 不可用时返回空数组，不阻断主流程
      console.error(`[LongMemory] 长期记忆获取失败:`, error);
      return [];
    }
  }
}

// 单例实例
let archiver: LongMemoryArchiver | null = null;

export function getLongMemoryArchiver(): LongMemoryArchiver {
  if (!archiver) {
    archiver = new LongMemoryArchiver();
  }
  return archiver;
}
