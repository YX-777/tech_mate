/**
 * 元记忆聚合器
 *
 * 大白话解释：
 * 就像你的性格和能力模型，决定了 Agent 怎么跟你交流。
 * 我们整合 UserProfile、ModuleProgress、LearningRecord，形成一个统一的"用户能力图谱"。
 */

import {
  getUserRepository,
  getModuleProgressRepository,
  getLearningRecordRepository,
  getMetaMemoryRepository,
  getStatsService,
} from "@tech-mate/database";
import { getReviewRecommendations, formatReviewBlock } from "./review-recommender";

export interface SkillGraphNode {
  module: string;
  proficiency: number;      // 熟练度 0-1
  questionsAttempted: number;
  lastPracticed: Date | null;
}

export interface MetaMemoryData {
  skillGraph: SkillGraphNode[];
  weakAreas: string[];
  strongAreas: string[];
  learningStyle: string | null;
  preferredTime: string | null;
  dailyGoal: number | null;
  totalHours: number;
  consecutiveDays: number;
  averageAccuracy: number;
}

export class MetaMemoryAggregator {
  /**
   * 聚合用户元记忆
   *
   * 技术流程：
   * 1. 从各 Repository 获取数据
   * 2. 计算能力图谱（基于 ModuleProgress）
   * 3. 分析学习偏好（从 LearningRecord 提取模式）
   * 4. 更新统计数据
   * 5. 生成向量（用于相似用户匹配）
   * 6. 存储到 MetaMemory 表
   */
  async aggregate(userId: string): Promise<MetaMemoryData> {
    console.log(`[MetaMemory] 开始聚合用户元记忆，用户: ${userId}`);

    const userRepo = getUserRepository();
    const moduleProgressRepo = getModuleProgressRepository();
    const learningRecordRepo = getLearningRecordRepository();
    const metaMemoryRepo = getMetaMemoryRepository();
    const statsService = getStatsService();

    // 1. 获取用户 Profile
    const profile = await userRepo.getUserProfile(userId);
    console.log(`[MetaMemory] 用户昵称: ${profile?.nickname || "学习者"}`);

    // 2. 获取模块进度（能力图谱）
    const progress = await moduleProgressRepo.findByUserId(userId);
    const skillGraph = this.buildSkillGraph(progress);
    console.log(`[MetaMemory] 技能图谱: ${skillGraph.length} 个模块`);

    // 3. 计算强项和弱项
    const weakAreas = progress
      .filter((p: any) => p.accuracy < 60)
      .map((p: any) => p.moduleName);
    const strongAreas = progress
      .filter((p: any) => p.accuracy >= 80)
      .map((p: any) => p.moduleName);

    console.log(`[MetaMemory] 强项: ${strongAreas.join(", ") || "暂无"}`);
    console.log(`[MetaMemory] 弱项: ${weakAreas.join(", ") || "暂无"}`);

    // 4. 获取学习偏好
    const learningStyle = profile?.learningStyle || await this.inferLearningStyle(userId);
    const preferredTime = await this.inferPreferredTime(userId);

    // 5. 获取统计数据
    const stats = await statsService.getStatsSummary(userId);
    const totalHours = stats.totalHours || 0;
    const consecutiveDays = stats.consecutiveDays || 0;
    const averageAccuracy = stats.avgAccuracy || 0;

    console.log(`[MetaMemory] 总学习时长: ${totalHours} 小时`);
    console.log(`[MetaMemory] 连续学习: ${consecutiveDays} 天`);
    console.log(`[MetaMemory] 平均正确率: ${averageAccuracy.toFixed(1)}%`);

    // 6. 构建元记忆数据
    const metaMemoryData: MetaMemoryData = {
      skillGraph,
      weakAreas,
      strongAreas,
      learningStyle,
      preferredTime,
      dailyGoal: profile?.dailyGoalHours || 4.0,
      totalHours,
      consecutiveDays,
      averageAccuracy,
    };

    // 7. 存储到 MetaMemory 表
    await metaMemoryRepo.upsertMeta(userId, {
      skillGraph: JSON.stringify(skillGraph),
      weakAreas: JSON.stringify(weakAreas),
      strongAreas: JSON.stringify(strongAreas),
      learningStyle,
      preferredTime,
      dailyGoal: profile?.dailyGoalHours,
      totalHours,
      consecutiveDays,
      averageAccuracy,
    });

    console.log(`[MetaMemory] 元记忆已保存`);

    return metaMemoryData;
  }

  /**
   * 构建技能图谱
   *
   * 技术原理：
   * 每个模块的熟练度 = 正确率 / 100（转换为 0-1 范围）
   */
  buildSkillGraph(progress: any[]): SkillGraphNode[] {
    return progress.map((p: any) => ({
      module: p.moduleName,
      proficiency: p.accuracy / 100,
      questionsAttempted: p.totalQuestions,
      lastPracticed: p.lastPracticedAt ? new Date(p.lastPracticedAt) : null,
    }));
  }

  /**
   * 推断学习风格
   *
   * 技术原理：
   * 分析用户的学习记录，推断偏好：
   * - 如果多做实践题 → "practice"
   * - 如果多阅读笔记 → "reading"
   * - 默认 → "mixed"
   */
  async inferLearningStyle(userId: string): Promise<string> {
    const learningRecordRepo = getLearningRecordRepository();

    // 获取最近 30 天的学习记录
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const records = await learningRecordRepo.findByUserId(userId, thirtyDaysAgo);

    if (records.length === 0) {
      return "mixed";
    }

    // 分析学习模式（简化版）
    // 未来可以扩展：分析笔记内容、题目类型等
    const practiceCount = records.filter((r: any) =>
      r.notes?.includes("practice") || r.notes?.includes("练习")
    ).length;

    if (practiceCount > records.length * 0.6) {
      return "practice";
    }

    return "mixed";
  }

  /**
   * 推断偏好的学习时间
   *
   * 技术原理：
   * 分析用户的学习记录时间分布：
   * - 早上学习多 → "morning"
   * - 下午学习多 → "afternoon"
   * - 晚上/深夜学习多 → "evening"
   */
  async inferPreferredTime(userId: string): Promise<string> {
    const learningRecordRepo = getLearningRecordRepository();

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const records = await learningRecordRepo.findByUserId(userId, thirtyDaysAgo);

    if (records.length === 0) {
      return "flexible";
    }

    // 分析时间分布
    let morning = 0, afternoon = 0, evening = 0;

    for (const record of records) {
      const hour = new Date(record.createdAt).getHours();
      if (hour >= 5 && hour < 12) morning++;
      else if (hour >= 12 && hour < 18) afternoon++;
      else evening++;
    }

    const max = Math.max(morning, afternoon, evening);
    if (max === morning) return "morning";
    if (max === afternoon) return "afternoon";
    return "evening";
  }

  /**
   * 获取用户元记忆摘要（用于 Agent prompt）
   */
  async getSummary(userId: string): Promise<string> {
    const metaMemoryRepo = getMetaMemoryRepository();
    const meta = await metaMemoryRepo.findByUserId(userId);

    if (!meta) {
      // 如果没有元记忆，先聚合
      const data = await this.aggregate(userId);
      return this.appendReview(userId, this.formatSummary(data));
    }

    const data: MetaMemoryData = {
      skillGraph: JSON.parse(meta.skillGraph || "[]"),
      weakAreas: JSON.parse(meta.weakAreas || "[]"),
      strongAreas: JSON.parse(meta.strongAreas || "[]"),
      learningStyle: meta.learningStyle,
      preferredTime: meta.preferredTime,
      dailyGoal: meta.dailyGoal,
      totalHours: meta.totalHours,
      consecutiveDays: meta.consecutiveDays,
      averageAccuracy: meta.averageAccuracy,
    };

    return this.appendReview(userId, this.formatSummary(data));
  }

  /**
   * 在元记忆摘要尾部追加"建议复习"块（艾宾浩斯遗忘曲线驱动）。
   * best-effort：复习推荐失败不影响画像注入。
   */
  private async appendReview(userId: string, base: string): Promise<string> {
    try {
      const block = formatReviewBlock(await getReviewRecommendations(userId));
      return block ? `${base}\n\n${block}` : base;
    } catch (e) {
      console.warn("[Meta] 复习建议生成失败，跳过", e);
      return base;
    }
  }

  /**
   * 格式化摘要文本
   */
  private formatSummary(data: MetaMemoryData): string {
    let summary = `【用户画像】\n`;
    summary += `- 学习风格: ${data.learningStyle || "未知"}\n`;
    summary += `- 强项: ${data.strongAreas.join(", ") || "暂无"}\n`;
    summary += `- 弱项: ${data.weakAreas.join(", ") || "暂无"}\n`;
    summary += `- 连续学习: ${data.consecutiveDays} 天\n`;
    summary += `- 平均正确率: ${data.averageAccuracy.toFixed(1)}%\n`;

    if (data.skillGraph.length > 0) {
      summary += `\n【技能图谱】\n`;
      data.skillGraph.forEach((s) => {
        summary += `- ${s.module}: 熟练度 ${(s.proficiency * 100).toFixed(0)}%\n`;
      });
    }

    return summary;
  }
}

// 单例实例
let aggregator: MetaMemoryAggregator | null = null;

export function getMetaMemoryAggregator(): MetaMemoryAggregator {
  if (!aggregator) {
    aggregator = new MetaMemoryAggregator();
  }
  return aggregator;
}
