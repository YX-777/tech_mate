import { createHash } from "crypto";
import { Article } from "../types";
import { simhash, hammingDistance, SIMHASH_DUP_THRESHOLD } from "./simhash";

/**
 * 内存去重：基于 SimHash 64-bit fingerprint + Hamming distance 近重复检测
 *
 * 跟旧版的 MD5 前 500 字符相比：
 *  - MD5：一字之差 hash 完全不同（雪崩效应），只能抓完全一样的内容
 *  - SimHash：相似文档 fingerprint 也相似，能识别"复制后稍作改写"的搬运文
 *
 * Hamming distance ≤ 3 视为近重复（阈值见 simhash.ts:SIMHASH_DUP_THRESHOLD）
 *
 * 复杂度：O(N) 对全量已见 fingerprint 做位运算 XOR + popcount，
 * 单条文档查询在万级语料下 < 10ms（位运算极快）
 */
export class ArticleDeduper {
  /** 已见的 SimHash fingerprint 集合（用于近重复比对） */
  private readonly seenFingerprints: bigint[] = [];
  /** 文章 id → fingerprint 的映射（用于 buildId 复用同一指纹） */
  private readonly idToFp = new Map<string, bigint>();

  /**
   * 计算 SimHash fingerprint —— 基于 title + content 前 2000 字
   * 标题加权（重复 3 次）让短改写不绕过
   */
  private computeSimhash(article: Article): bigint {
    const title = article.title || "";
    const content = (article.content || "").slice(0, 2000);
    const text = `${title} ${title} ${title} ${content}`;
    return simhash(text);
  }

  /**
   * 检查是否近重复。返回 true 表示通过（非重复），同时记录指纹
   */
  check(article: Article): boolean {
    const fp = this.computeSimhash(article);

    // 对照已见 fingerprint 找 Hamming distance ≤ 阈值的
    for (const seen of this.seenFingerprints) {
      if (hammingDistance(fp, seen) <= SIMHASH_DUP_THRESHOLD) {
        return false; // 近重复，丢弃
      }
    }

    this.seenFingerprints.push(fp);
    // 给后续 buildId 复用
    const key = `${article.source || "?"}::${article.sourceUrl || article.title || ""}`;
    this.idToFp.set(key, fp);
    return true;
  }

  /**
   * 给文章生成稳定 id（用于 ChromaDB add 时去重）—— SimHash 的低 12 位 hex
   */
  buildId(article: Article): string {
    const key = `${article.source || "?"}::${article.sourceUrl || article.title || ""}`;
    let fp = this.idToFp.get(key);
    if (fp === undefined) fp = this.computeSimhash(article);

    // 取 fingerprint 低 48 位转 hex —— 跟 md5 截 12 位保持相同长度，
    // ChromaDB id 列宽不变，便于跟历史数据兼容
    const lo = fp & 0xffffffffffffn;
    const fpHex = lo.toString(16).padStart(12, "0");
    const src = (article.source || "unknown").replace(/[^a-z0-9]/gi, "");
    return `art_${src}_${fpHex}`;
  }

  /**
   * 兼容旧接口：基于 content 头部的 md5 摘要（仅在 import 时希望生成跟旧库一致的 id 用）
   * 当前主流程不依赖此方法，仅保留备用
   */
  legacyMd5Fingerprint(article: Article): string {
    const sample = (article.content || "").slice(0, 500).replace(/\s+/g, "");
    return createHash("md5").update(sample).digest("hex");
  }
}
