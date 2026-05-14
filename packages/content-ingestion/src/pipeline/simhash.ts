/**
 * SimHash 局部敏感哈希 —— 用于近重复文档检测
 *
 * 算法：Charikar (2002) "Similarity Estimation Techniques from Rounding Algorithms"
 *
 * 流程：
 *  1. 把文本切成 token（中文 bigram + 英文词）+ 频次作为权重
 *  2. 每个 token 算 64-bit hash，按 bit 投票（1 加权重，0 减权重）
 *  3. 64 维向量按符号转回 fingerprint
 *  4. 两文档相似度用 Hamming distance 衡量（越小越像）
 *  5. 阈值经验值 ≤ 3 视为近重复
 *
 * 跟 MD5 的差别：MD5 一字之差 hash 完全不同（雪崩效应）；
 *                SimHash 相似文档 fingerprint 也相似，能识别"复制后稍作改写"
 */

import { createHash } from "crypto";

/**
 * 把文本切成 token 列表（中文 bigram + 英文词），用于 SimHash 输入
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  const cleaned = text
    .toLowerCase()
    .replace(/[，。！？,.!?；;:：、（）()\[\]【】「」""''\n\r\t]/g, " ");

  const tokens: string[] = [];

  // 英文/数字 token（>= 2 字符）
  const englishRe = /[a-z0-9][a-z0-9\-_]*/g;
  let m: RegExpExecArray | null;
  while ((m = englishRe.exec(cleaned)) !== null) {
    if (m[0].length >= 2) tokens.push(m[0]);
  }

  // 中文 bigram —— 抽出连续中文片段，按 2-gram 滑窗
  const cjkRe = /[一-鿿]+/g;
  while ((m = cjkRe.exec(cleaned)) !== null) {
    const seg = m[0];
    if (seg.length === 1) tokens.push(seg);
    else {
      for (let i = 0; i <= seg.length - 2; i++) {
        tokens.push(seg.slice(i, i + 2));
      }
    }
  }

  return tokens;
}

/**
 * 64-bit 稳定哈希：取 md5 前 8 字节转 bigint
 */
function hash64(token: string): bigint {
  const buf = createHash("md5").update(token).digest();
  // 取前 8 字节构造 64-bit BigInt
  let h = 0n;
  for (let i = 0; i < 8; i++) {
    h = (h << 8n) | BigInt(buf[i]);
  }
  return h;
}

/**
 * 计算文档的 64-bit SimHash fingerprint
 */
export function simhash(text: string): bigint {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0n;

  // 累计 token 频次作为权重
  const weights = new Map<string, number>();
  for (const t of tokens) weights.set(t, (weights.get(t) || 0) + 1);

  // 64 维向量加权投票
  const vec = new Int32Array(64);
  for (const [token, weight] of weights) {
    const h = hash64(token);
    for (let i = 0; i < 64; i++) {
      const bit = Number((h >> BigInt(i)) & 1n);
      vec[i] += bit ? weight : -weight;
    }
  }

  // 按符号转回 fingerprint
  let fp = 0n;
  for (let i = 0; i < 64; i++) {
    if (vec[i] > 0) fp |= 1n << BigInt(i);
  }
  return fp;
}

/**
 * Hamming distance —— a ^ b 后数 1 的位数
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count++;
    x &= x - 1n; // Brian Kernighan: 每次清掉最低位的 1
  }
  return count;
}

/**
 * 阈值：经验值 3（64-bit fingerprint，相当于 < 5% 不同位）
 *
 * - 0：完全相同
 * - 1-3：近重复（改了一两个段落 / 同义词替换）
 * - 4-10：相关但不算重复
 * - 10+：基本不同主题
 */
export const SIMHASH_DUP_THRESHOLD = 3;

/**
 * 判断 a 和 b 是否近重复（≤ 阈值）
 */
export function isNearDuplicate(a: bigint, b: bigint, threshold = SIMHASH_DUP_THRESHOLD): boolean {
  return hammingDistance(a, b) <= threshold;
}
