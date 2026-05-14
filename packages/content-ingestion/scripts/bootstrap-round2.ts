/**
 * 补量 round-2 —— 在 bootstrap-300 跑完后追加补量
 *
 * 策略：复用三个能用的 adapter，但因 adapter 已经扩了源列表
 *  - generic-rss: FEEDS 15 → 23（+8 个一手博客）
 *  - awesome:     REPOS 18 → 30（+12 个新主题）
 *  - devto:       TAGS 12 → 20（+8 个 tag）
 *
 * dedup 在 SimHash + ChromaDB id 两层兜底，新源带来的内容自然累加，
 * 已抓过的内容自动跳过。
 */
import { DevtoAdapter } from "../src/adapters/devto-adapter";
import { GithubAwesomeAdapter } from "../src/adapters/github-awesome-adapter";
import { GenericRssAdapter } from "../src/adapters/generic-rss-adapter";
import { persistArticles } from "../src/persister";
import { IngestStats } from "../src/types";

interface AdapterJob {
  name: string;
  adapter: { fetch: (o: any) => Promise<any[]> };
  limit: number;
  filter?: any;
}

// Round-2 limits 比 round-1 更大，因为新增源 + dedup 后实际入库数可能不多
const JOBS: AdapterJob[] = [
  // 一手 RSS（已扩到 23 源）—— limit 大点让新增源吃满
  { name: "generic-rss-r2", adapter: new GenericRssAdapter(), limit: 800,
    filter: { minLength: 300, maxLength: 30000, requireKeyword: false, maxAgeDays: 730, strictAge: false } },
  // GitHub awesome（已扩到 30 repo）
  { name: "awesome-r2", adapter: new GithubAwesomeAdapter(), limit: 1500,
    filter: { minLength: 500, maxLength: 20000, requireKeyword: false, maxAgeDays: 730, strictAge: false } },
  // dev.to（已扩到 20 tag）
  { name: "devto-r2", adapter: new DevtoAdapter(), limit: 2000,
    filter: { minLength: 300, maxLength: 30000, requireKeyword: true, maxAgeDays: 730, strictAge: true } },
];

async function main() {
  const allStats: IngestStats[] = [];
  console.log(`\n🚀 TechMate 知识库 round-2 补量启动`);
  console.log(`目标：在 round-1 基础上再补 1500-2500 chunks，冲击 5000+ 总量\n`);

  for (const job of JOBS) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`📥 [${job.name}] limit=${job.limit}`);
    console.log(`${"─".repeat(60)}`);

    const t0 = Date.now();
    try {
      const articles = await job.adapter.fetch({ limit: job.limit, verbose: false });
      console.log(`  fetched ${articles.length} articles in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      const stats = await persistArticles(job.name, articles, {
        verbose: false,
        filter: job.filter,
      });
      allStats.push(stats);

      console.log(
        `  → persisted ${stats.persisted}, filtered out ${stats.fetched - stats.filtered}, ` +
        `dup ${stats.filtered - stats.deduped}, failed ${stats.failed}`
      );
    } catch (e: any) {
      console.error(`  ❌ [${job.name}] crashed: ${e?.message || e}`);
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`✅ round-2 完成`);
  console.log(`${"═".repeat(60)}`);
  for (const s of allStats) {
    console.log(`  ${s.source}: fetched=${s.fetched} persisted=${s.persisted}`);
  }
  const sum = allStats.reduce((a, s) => a + (s.persisted || 0), 0);
  console.log(`  合计新增: ${sum} chunks`);
}

main().catch((e) => {
  console.error("\n❌ round-2 fatal:", e);
  process.exit(1);
});
