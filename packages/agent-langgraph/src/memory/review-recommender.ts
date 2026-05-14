/**
 * 模块复习推荐 —— 艾宾浩斯遗忘曲线驱动
 *
 * 大白话：每个学习模块按"上次练习到现在过了多久"算预测保持度（遗忘曲线），
 * 掌握得好的模块记得久（半衰期长），薄弱模块衰减快（更早被推来复习）。
 * 保持度低于阈值就建议复习。
 *
 * 诚实边界（防穿帮）：
 *  - 粒度是**模块级**（ModuleProgress），不是知识点级，和简历口径一致。
 *  - 用的遗忘曲线是 short.ts 的 ebbinghausRetention **同一个函数**——
 *    "复习推荐"和"短期记忆归档"共用同一条曲线，不是两套各写一份。
 *  - 没练过的模块（lastPracticedAt 为空）无法算遗忘，诚实跳过，不臆造。
 *  - v1 不做 SM-2 递增间隔（需加 schema 列），列为路线图，不写进简历。
 */
import { getModuleProgressRepository } from "@tech-mate/database";
import { ebbinghausRetention } from "./short";
import { withSpan } from "../otel/instrumentation";

export interface ModuleForReview {
  moduleName: string;
  accuracy: number; // 0-100
  lastPracticedAt: Date | null;
}

export interface ReviewItem {
  moduleName: string;
  accuracy: number;
  daysSincePractice: number;
  halfLifeDays: number;
  retention: number; // 0-1 预测保持度
  reason: string;
}

const BASE_HALF_LIFE_DAYS = 7; // 与短期记忆衰减同基线
const RETENTION_THRESHOLD = 0.5; // 低于此判定"该复习了"
const MAX_ITEMS = 3;

/**
 * accuracy 调制半衰期：掌握度高 → 记得久（半衰期长）；薄弱 → 衰减快、更早推。
 * accuracy 0 → 0.5×base；100 → 1.5×base。
 */
export function halfLifeForAccuracy(accuracy: number, base = BASE_HALF_LIFE_DAYS): number {
  const a = Math.min(100, Math.max(0, accuracy)) / 100;
  return base * (0.5 + a);
}

/**
 * 纯函数：给定模块数据 + now，算出该复习清单（确定性，可单测）。
 */
export function scoreModulesForReview(
  modules: ModuleForReview[],
  now: Date = new Date(),
  opts: { threshold?: number; max?: number } = {}
): ReviewItem[] {
  const threshold = opts.threshold ?? RETENTION_THRESHOLD;
  const max = opts.max ?? MAX_ITEMS;
  const items: ReviewItem[] = [];

  for (const m of modules) {
    if (!m.lastPracticedAt) continue; // 没练过，无法算遗忘曲线，诚实跳过
    const days = (now.getTime() - new Date(m.lastPracticedAt).getTime()) / 86_400_000;
    if (days < 0) continue;
    const halfLife = halfLifeForAccuracy(m.accuracy);
    const retention = ebbinghausRetention(days, halfLife);
    if (retention >= threshold) continue;
    items.push({
      moduleName: m.moduleName,
      accuracy: Math.round(m.accuracy),
      daysSincePractice: Math.round(days),
      halfLifeDays: Number(halfLife.toFixed(1)),
      retention: Number(retention.toFixed(2)),
      reason: `${Math.round(days)} 天没练，预测保持度 ${Math.round(retention * 100)}%`,
    });
  }

  // 最该复习的（保持度最低）排前面
  return items.sort((a, b) => a.retention - b.retention).slice(0, max);
}

/**
 * 取某用户的模块复习建议（读 ModuleProgress → 套遗忘曲线）。
 * DB 异常时返回空数组，绝不阻断主流程 / 不臆造。
 */
export async function getReviewRecommendations(userId: string): Promise<ReviewItem[]> {
  return withSpan("memory.review", async (sp) => {
    let modules: ModuleForReview[] = [];
    try {
      const repo = getModuleProgressRepository();
      const rows = await repo.findByUserId(userId);
      modules = rows.map((p: any) => ({
        moduleName: p.moduleName,
        accuracy: typeof p.accuracy === "number" ? p.accuracy : 0,
        lastPracticedAt: p.lastPracticedAt ? new Date(p.lastPracticedAt) : null,
      }));
    } catch (e) {
      console.warn("[ReviewRec] 读取 ModuleProgress 失败，跳过复习推荐", e);
      return [];
    }
    const items = scoreModulesForReview(modules);
    sp?.setAttributes({ candidates: modules.length, recommended: items.length });
    return items;
  });
}

/**
 * 给 prompt / 推送复用的一行式摘要；无建议返回空串。
 */
export function formatReviewBlock(items: ReviewItem[]): string {
  if (items.length === 0) return "";
  const lines = items.map((i) => `- ${i.moduleName}：${i.reason}（建议复习）`).join("\n");
  return `【建议复习（艾宾浩斯遗忘曲线）】\n${lines}`;
}
