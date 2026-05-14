import { getVectorDBService, getEmbeddingService } from "@tech-mate/database";
import { Article, IngestStats } from "./types";
import { ArticleFilter, FilterOptions } from "./pipeline/filter";
import { ArticleDeduper } from "./pipeline/deduper";
import { chunk } from "./pipeline/chunker";
import { scoreArticle, DEFAULT_QUALITY_THRESHOLD } from "./pipeline/quality-score";

/**
 * 写入 ChromaDB tech_knowledge collection
 * - 拒重：内存指纹 + ChromaDB id 唯一约束兜底
 * - 限流：embedding API 调用间隔 250ms（4 QPS，远低于 DashScope 60 QPS 上限）
 */

const COLLECTION = "tech_knowledge";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface PersistOptions {
  filter?: FilterOptions;
  /** 真实写库还是只 dry-run（打印不写） */
  dryRun?: boolean;
  /** embedding 调用间隔 */
  rateLimitMs?: number;
  verbose?: boolean;
  /**
   * 质量分阈值（0-1），低于此值丢弃。0 = 关闭评分卡控，仅记录在 metadata。
   * 默认 0（向后兼容），推荐生产开 0.45 保守过滤
   */
  qualityThreshold?: number;
}

export async function persistArticles(
  source: string,
  articles: Article[],
  opt: PersistOptions = {},
): Promise<IngestStats> {
  const stats: IngestStats = {
    source,
    fetched: articles.length,
    filtered: 0,
    deduped: 0,
    persisted: 0,
    failed: 0,
  };

  const filter = new ArticleFilter(opt.filter || {});
  const deduper = new ArticleDeduper();
  const verbose = opt.verbose ?? false;
  const rate = opt.rateLimitMs ?? 250;
  const qualityThreshold = opt.qualityThreshold ?? 0; // 0 表示仅记录、不卡控

  // 过滤 + 质量评分 + 去重 + chunk 展开
  // 流水线顺序：filter(布尔) → quality score(连续打分) → simhash dedup → chunk
  // 评分卡在 dedup 之前——分太低直接丢，省下 simhash 算力；通过的文档把分数挂到 metadata
  const toPersist: Article[] = [];
  for (const art of articles) {
    const verdict = filter.accept(art);
    if (!verdict.ok) {
      if (verbose) console.log(`  ✗ filtered: ${verdict.reason} — ${art.title.slice(0, 40)}`);
      continue;
    }
    stats.filtered++;

    // 质量评分（5 维加权 0-1）
    const score = scoreArticle(art);
    if (qualityThreshold > 0 && score.total < qualityThreshold) {
      if (verbose) console.log(`  ✗ low-quality(${score.total}<${qualityThreshold}): ${art.title.slice(0, 40)}`);
      continue;
    }

    if (!deduper.check(art)) {
      if (verbose) console.log(`  ✗ dup: ${art.title.slice(0, 40)}`);
      continue;
    }
    stats.deduped++;

    // 把质量分透传到 metadata，供后续 RAG / dashboard 排序
    (art as any).qualityScore = score.total;
    (art as any).qualityDetail = score;

    // chunk 长文
    const pieces = chunk(art);
    // 父文章的 quality 透传到每个 chunk（同一文档的 chunks 共享父分数）
    for (const p of pieces) {
      (p as any).qualityScore = score.total;
    }
    toPersist.push(...pieces);
  }

  if (opt.dryRun) {
    console.log(`[persist] DRY-RUN: ${source} would persist ${toPersist.length} chunks`);
    return stats;
  }

  // 真实写库
  const vectorService = getVectorDBService();
  const embeddingService = getEmbeddingService();
  await vectorService.initialize();

  for (const piece of toPersist) {
    try {
      const vector = await embeddingService.generateEmbedding(piece.content);
      const id = deduper.buildId(piece);
      await vectorService.addEmbedding(
        COLLECTION,
        id,
        vector,
        {
          title: piece.title,
          source: piece.source,
          source_url: piece.sourceUrl || "",
          category: piece.category || "general",
          author: piece.author || "",
          tags: (piece.tags || []).join(","),
          published_at: piece.publishedAt || "",
          ingested_at: new Date().toISOString(),
          quality_score: (piece as any).qualityScore ?? 0,
        },
        piece.content,
      );
      stats.persisted++;
      if (verbose) console.log(`  ✓ ${piece.title.slice(0, 50)}`);
    } catch (e: any) {
      stats.failed++;
      const msg = e?.message || String(e);
      // ChromaDB duplicate id 是预期的（幂等），不算 fail
      if (msg.toLowerCase().includes("already exists") || msg.includes("duplicate")) {
        if (verbose) console.log(`  ~ exists: ${piece.title.slice(0, 40)}`);
        stats.failed--; // 抵消
      } else {
        console.warn(`  ! persist failed: ${msg}`);
      }
    }
    if (rate > 0) await sleep(rate);
  }

  return stats;
}
