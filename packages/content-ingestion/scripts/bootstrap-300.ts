/**
 * 一键补量
 *
 * 依次跑多个 adapter，扩展 ChromaDB tech_knowledge collection。
 * 失败不中断 —— 单个 adapter 挂了不影响其他。
 *
 * 来源调整（2026-05-14）：
 * - 移除 ruanyf 周刊（用户不喜欢，内容主题杂）
 * - 移除 hf-blog / langchain-blog（域名当前网络不可达，HTTP 000）
 * - 扩 awesome 到 18 个 repo，扩 devto 限额
 * - 新增 generic-rss adapter，覆盖 15+ 一手技术博客 RSS
 * - 全部启用 maxAgeDays=730（2 年）—— 前端/AI 技术演进太快，老内容误导用户
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

// 目标：把 tech_knowledge 从当前 ~750 推到 5000+
const JOBS: AdapterJob[] = [
  // 一手 RSS（最重要的新源；含 Vercel / Next.js / web.dev / overreacted / Kent Dodds / Mozilla Hacks / OpenAI 等）
  { name: "generic-rss", adapter: new GenericRssAdapter(), limit: 500,
    filter: { minLength: 300, maxLength: 30000, requireKeyword: false, maxAgeDays: 730, strictAge: false } },
  // GitHub awesome 列表（18 个 repo，覆盖 React/Vue/Angular/CSS/Node/Docker/LLM/RAG/LangChain/TypeScript）
  // awesome list 是 curated 内容，没有标准 publishedAt，strictAge=false 让它透传
  { name: "awesome", adapter: new GithubAwesomeAdapter(), limit: 1000,
    filter: { minLength: 500, maxLength: 20000, requireKeyword: false, maxAgeDays: 730, strictAge: false } },
  // dev.to —— 12 个 tag（ai/llm/agent/react/typescript/node 等）
  { name: "devto", adapter: new DevtoAdapter(), limit: 1500,
    filter: { minLength: 300, maxLength: 30000, requireKeyword: true, maxAgeDays: 730, strictAge: true } },
];

async function main() {
  const allStats: IngestStats[] = [];
  console.log(`\n🚀 TechMate 知识库 bootstrap 启动`);
  console.log(`目标：扩展 tech_knowledge collection 至 5000+ 条\n`);

  for (const job of JOBS) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`📥 [${job.name}] limit=${job.limit}`);
    console.log(`${"─".repeat(60)}`);

    const t0 = Date.now();
    try {
      const articles = await job.adapter.fetch({ limit: job.limit, verbose: false });
      console.log(`  fetched ${articles.length} articles in ${((Date.now() - t0)/1000).toFixed(1)}s`);

      if (articles.length === 0) {
        allStats.push({ source: job.name, fetched: 0, filtered: 0, deduped: 0, persisted: 0, failed: 0 });
        continue;
      }

      const stats = await persistArticles(job.name, articles, {
        filter: job.filter,
        verbose: false,
      });
      console.log(`  → persisted ${stats.persisted}, filtered out ${stats.fetched - stats.filtered}, dup ${stats.filtered - stats.deduped}, failed ${stats.failed}`);
      allStats.push(stats);
    } catch (err: any) {
      console.error(`  ❌ [${job.name}] failed: ${err?.message || err}`);
      allStats.push({ source: job.name, fetched: 0, filtered: 0, deduped: 0, persisted: 0, failed: 1 });
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`📊 汇总`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  source       fetched  filtered  deduped  persisted  failed`);
  let totalPersisted = 0;
  for (const s of allStats) {
    console.log(`  ${s.source.padEnd(12)} ${String(s.fetched).padStart(7)}  ${String(s.filtered).padStart(8)}  ${String(s.deduped).padStart(7)}  ${String(s.persisted).padStart(9)}  ${String(s.failed).padStart(6)}`);
    totalPersisted += s.persisted;
  }
  console.log(`\n  ✅ 总计入库 ${totalPersisted} 条 chunks`);
}

main().catch((err) => {
  console.error("bootstrap failed:", err);
  process.exit(1);
});
