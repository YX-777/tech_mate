import { Article, FetchOptions, IContentAdapter } from "../types";

/**
 * dev.to 官方 API adapter
 *
 * API 文档：https://developers.forem.com/api/v1
 * 两阶段：
 *   1. /api/articles?per_page=N&tag=X → 列表（不带 body）
 *   2. /api/articles/{id} → 详情（带 body_markdown）
 *
 * 限频：免费 token 30 req/30s，无 token 也能用，但慢。
 * 这里不带 token，单 adapter 限制 100 条左右刚好。
 */

// AI 主题前置（前几个 tag 会拉更多文章），保证 ai/agent/llm/langchain 类目占比
const TAGS = [
  // AI / LLM 核心
  "ai", "llm", "agent", "langchain", "rag", "machinelearning", "openai",
  // 前端核心
  "javascript", "react", "typescript", "webdev", "node",
  // Round-2 扩展 tag
  "nextjs", "vuejs", "tutorial", "programming", "devops",
  "css", "performance", "testing", "architecture",
];
const BASE = "https://dev.to";

interface DevtoListItem {
  id: number;
  title: string;
  description: string;
  url: string;
  published_timestamp: string;
  // 列表 API: tag_list 是数组；详情 API: tag_list 是逗号分隔字符串，tags 是数组
  tag_list?: string[] | string;
  tags?: string[];
  user?: { name?: string };
}

interface DevtoDetail extends DevtoListItem {
  body_markdown?: string;
}

/**
 * 把 tag_list（可能是 string 或 string[]）和 tags（string[]）规整为 string[]
 */
function normalizeTags(item: DevtoListItem): string[] {
  if (Array.isArray(item.tags)) return item.tags;
  if (Array.isArray(item.tag_list)) return item.tag_list;
  if (typeof item.tag_list === "string") {
    return item.tag_list.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
}

function categoryFromTags(tags: string[] = []): string {
  const tl = tags.map((t) => t.toLowerCase());
  if (tl.some((t) => ["langchain", "langgraph"].includes(t))) return "langchain";
  if (tl.some((t) => ["rag", "retrievalaugmentation"].includes(t))) return "rag";
  if (tl.some((t) => ["agent", "agentic", "autonomousagent"].includes(t))) return "agent";
  if (tl.some((t) => ["llm", "gpt", "claude", "openai", "anthropic"].includes(t))) return "llm";
  if (tl.some((t) => ["ai", "machinelearning", "ml"].includes(t))) return "ai";
  if (tl.some((t) => ["react", "vue", "angular", "svelte", "css", "html", "frontend", "webdev"].includes(t))) return "frontend";
  if (tl.some((t) => ["node", "backend", "python", "go", "rust"].includes(t))) return "backend";
  return "general";
}

async function fetchJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "TechMate-Ingestion/1.0" },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class DevtoAdapter implements IContentAdapter {
  readonly source = "devto";

  async fetch(options: FetchOptions = {}): Promise<Article[]> {
    const limit = options.limit ?? 60;
    const perTagLimit = Math.ceil(limit / TAGS.length) + 2;
    const verbose = options.verbose;

    // 阶段 1：拉列表
    const listItems: DevtoListItem[] = [];
    for (const tag of TAGS) {
      try {
        const items = await fetchJson<DevtoListItem[]>(
          `${BASE}/api/articles?per_page=${perTagLimit}&tag=${encodeURIComponent(tag)}`,
        );
        listItems.push(...items);
        if (verbose) console.log(`[devto] tag=${tag} got ${items.length} items`);
        await sleep(300);
      } catch (e: any) {
        console.warn(`[devto] tag=${tag} list failed: ${e?.message || e}`);
      }
    }

    // 去重（dev.to 跨 tag 可能重复）+ 截断
    const seen = new Set<number>();
    const uniq = listItems.filter((x) => {
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return true;
    }).slice(0, limit);

    // 阶段 2：取详情拿正文
    const articles: Article[] = [];
    for (const item of uniq) {
      try {
        const detail = await fetchJson<DevtoDetail>(`${BASE}/api/articles/${item.id}`);
        const md = (detail.body_markdown || "").trim();
        if (!md) continue;
        const tagsArr = normalizeTags(detail);
        articles.push({
          title: detail.title,
          content: stripHtml(md),
          source: this.source,
          sourceUrl: detail.url,
          category: categoryFromTags(tagsArr),
          publishedAt: detail.published_timestamp,
          author: detail.user?.name,
          tags: tagsArr,
        });
        if (verbose) console.log(`[devto] +${detail.title.slice(0, 60)}`);
        await sleep(400);
      } catch (e: any) {
        console.warn(`[devto] detail ${item.id} failed: ${e?.message || e}`);
      }
    }

    return articles;
  }
}
