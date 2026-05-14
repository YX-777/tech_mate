/**
 * 语义相似度工具 —— embedding 余弦
 *
 * 替代原先 Jaccard 词面相似度。词面 Jaccard 对"短问题 vs 长答案""不同网页摘要"
 * 恒趋近 0，是误报源（L3 相关性 1%、多源一致度 0.008 都是它造的）。
 *
 * 口径（技术细节必须说得清）：
 *   - 向量：DashScope `text-embedding-v2`，1536 维（与知识库同一 embedding 空间）
 *   - 相似度：标准余弦 = dot(a,b) / (‖a‖·‖b‖)，理论 [-1,1]，中文文本实际多在 [0,1]
 *   - 失败策略：embedding 不可用 → 返回 null，调用方"诚实标注未计算"，**绝不伪造分数**
 */

import { getEmbeddingService } from "@tech-mate/database";
import { logger } from "@tech-mate/core";

/** 余弦相似度。等长向量；任一为空/零向量返回 0。 */
export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 两段文本的语义相似度（一次 batch=2 的 embedding 调用 + 余弦）。
 * 任一为空或 embedding 失败 → null（调用方标注"未计算"，不误报、不造数）。
 */
export async function semanticSimilarity(textA: string, textB: string): Promise<number | null> {
  const a = (textA || "").trim();
  const b = (textB || "").trim();
  if (!a || !b) return null;
  try {
    const [va, vb] = await getEmbeddingService().generateBatchEmbeddings([a, b]);
    if (!va || !vb) return null;
    return cosine(va, vb);
  } catch (e) {
    logger.warn(
      `[semantic-sim] embedding 失败，相似度标注为"未计算": ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

/**
 * 一组文本的"平均两两语义相似度"——用于多源一致度。
 * 有效文本 < 2 段无意义 → null；embedding 失败 → null。
 */
export async function averagePairwiseSimilarity(texts: string[]): Promise<number | null> {
  const clean = texts.map((t) => (t || "").trim()).filter((t) => t.length > 0);
  if (clean.length < 2) return null;
  try {
    const vecs = await getEmbeddingService().generateBatchEmbeddings(clean);
    if (!vecs || vecs.length < 2) return null;
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        sum += cosine(vecs[i], vecs[j]);
        pairs++;
      }
    }
    return pairs > 0 ? sum / pairs : null;
  } catch (e) {
    logger.warn(
      `[semantic-sim] 多源 embedding 失败，一致度标注为"未计算": ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}
