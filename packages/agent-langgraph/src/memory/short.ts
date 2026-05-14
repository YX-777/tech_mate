/**
 * 短期记忆衰减计算器
 *
 * 大白话解释：
 * 就像你前几天做的事，记得但不那么清晰。
 * 我们给每条记忆一个"新鲜度分数"，越久越低，超过 7 天自动归档到长期记忆。
 */

export interface ShortMemory {
  id: string;
  userId: string;
  conversationId: string;
  content: string;
  contentType: string;
  createdAt: Date;
  lastAccessedAt: Date;
  freshnessScore: number;   // 新鲜度 0-1
  accessCount: number;      // 访问次数
  topicTags: string[];      // 话题标签
  archived: boolean;
}

export interface DecayResult {
  freshnessScore: number;
  shouldArchive: boolean;
  reason: string;
}

/**
 * 艾宾浩斯式遗忘曲线 —— **单一来源**。
 * 保持度 = 0.5^(已过天数 / 半衰期)。
 * 短期记忆归档(本文件)与模块复习推荐(review-recommender)共用这同一条曲线，
 * 所以简历"艾宾浩斯衰减推荐复习"和记忆衰减是同一套数学，不是两套。
 */
export function ebbinghausRetention(daysElapsed: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 0;
  return Math.pow(0.5, Math.max(0, daysElapsed) / halfLifeDays);
}

export class ShortMemoryDecayCalculator {
  // 半衰期：7 天（记忆强度每 7 天衰减一半）
  private HALF_LIFE_DAYS = 7;

  // 归档阈值：低于此值则归档到长期记忆
  private ARCHIVE_THRESHOLD = 0.1;

  /**
   * 计算新鲜度分数
   *
   * 衰减公式：
   * 新鲜度 = 0.5^(天数/半衰期) + 访问强化 + 最近访问奖励
   *
   * 技术原理：
   * - 指数衰减：模拟人类记忆随时间淡忘
   * - 半衰期 = 7 天：每 7 天记忆强度减半
   * - 访问强化：每次访问增加 0.1 新鲜度（最多 +0.5）
   * - 最近访问奖励：昨天刚访问额外 +0.2
   */
  calculateFreshness(memory: ShortMemory): DecayResult {
    const daysSinceCreation = this.daysBetween(memory.createdAt, new Date());
    const daysSinceAccess = this.daysBetween(memory.lastAccessedAt, new Date());

    // 基础衰减：指数衰减（复用单一来源 ebbinghausRetention）
    const baseDecay = ebbinghausRetention(daysSinceCreation, this.HALF_LIFE_DAYS);

    // 访问强化：每次访问增加 0.1 新鲜度（最多增加 0.5）
    const accessBoost = Math.min(memory.accessCount * 0.1, 0.5);

    // 最近访问额外奖励
    const recentAccessBonus = daysSinceAccess < 1 ? 0.2 : 0;

    // 最终新鲜度（上限 1.0）
    const freshness = Math.min(baseDecay + accessBoost + recentAccessBonus, 1.0);

    // 判断是否需要归档
    const shouldArchive = freshness < this.ARCHIVE_THRESHOLD;

    // 生成原因说明
    let reason = `基础衰减=${baseDecay.toFixed(2)}, 访问强化=${accessBoost.toFixed(2)}, 最近访问奖励=${recentAccessBonus.toFixed(2)}`;
    if (shouldArchive) {
      reason += ` → 低于阈值 ${this.ARCHIVE_THRESHOLD}，需归档`;
    }

    console.log(`[ShortMemory] 衰减计算: ${memory.id}`);
    console.log(`  - 创建天数: ${daysSinceCreation}, 访问天数: ${daysSinceAccess}`);
    console.log(`  - ${reason}`);
    console.log(`  - 最终新鲜度: ${freshness.toFixed(2)}`);

    return {
      freshnessScore: freshness,
      shouldArchive,
      reason,
    };
  }

  /**
   * 判断是否需要归档
   */
  shouldArchive(memory: ShortMemory): boolean {
    return this.calculateFreshness(memory).shouldArchive;
  }

  /**
   * 批量计算衰减
   */
  calculateBatch(memories: ShortMemory[]): DecayResult[] {
    console.log(`[ShortMemory] 批量衰减计算，共 ${memories.length} 条记忆`);

    const results = memories.map((m) => this.calculateFreshness(m));

    const toArchive = results.filter((r) => r.shouldArchive).length;
    console.log(`[ShortMemory] 需归档: ${toArchive} 条`);

    return results;
  }

  /**
   * 计算两个日期之间的天数
   */
  private daysBetween(date1: Date, date2: Date): number {
    const diffMs = Math.abs(date2.getTime() - date1.getTime());
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }

  /**
   * 获取衰减配置
   */
  getConfig(): { halfLifeDays: number; archiveThreshold: number } {
    return {
      halfLifeDays: this.HALF_LIFE_DAYS,
      archiveThreshold: this.ARCHIVE_THRESHOLD,
    };
  }

  /**
   * 更新衰减配置
   */
  updateConfig(config: { halfLifeDays?: number; archiveThreshold?: number }): void {
    if (config.halfLifeDays) {
      this.HALF_LIFE_DAYS = config.halfLifeDays;
    }
    if (config.archiveThreshold) {
      this.ARCHIVE_THRESHOLD = config.archiveThreshold;
    }
  }
}

// 单例实例
let decayCalculator: ShortMemoryDecayCalculator | null = null;

export function getShortMemoryDecayCalculator(): ShortMemoryDecayCalculator {
  if (!decayCalculator) {
    decayCalculator = new ShortMemoryDecayCalculator();
  }
  return decayCalculator;
}
