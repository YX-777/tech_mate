/**
 * 通用 RSS / Atom adapter —— 抓一手技术博客
 *
 * 设计：维护一个 curated RSS feeds 白名单，逐个抓取并解析。
 * 单个 feed 失败不影响整体（很多博客 feed 时不时挂），最大努力收集。
 *
 * 选源原则：
 *  - 一手内容（作者本人维护的官方博客）
 *  - 前端 / AI Agent / 工程实践方向
 *  - feed 在国内可直连（CN-friendly），不在 GFW 黑名单
 *  - publishedAt 元数据齐全（让 age filter 能正常工作）
 */

import { XMLParser } from "fast-xml-parser";
import { Article, FetchOptions, IContentAdapter } from "../types";

interface RSSFeed {
  url: string;
  category: string;
  source: string;
  hint: string;
}

const FEEDS: RSSFeed[] = [
  // —— 前端权威博客 ——
  { url: "https://overreacted.io/rss.xml", category: "frontend", source: "overreacted", hint: "Dan Abramov / React" },
  { url: "https://kentcdodds.com/blog/rss.xml", category: "frontend", source: "kent-c-dodds", hint: "Kent C. Dodds / Testing+React" },
  { url: "https://nextjs.org/feed.xml", category: "frontend", source: "nextjs-blog", hint: "Next.js 官方" },
  { url: "https://vercel.com/atom", category: "frontend", source: "vercel-blog", hint: "Vercel 官方" },
  { url: "https://hacks.mozilla.org/feed/", category: "frontend", source: "mozilla-hacks", hint: "Mozilla Hacks" },
  { url: "https://web.dev/feed.xml", category: "frontend", source: "web-dev", hint: "Google web.dev" },
  { url: "https://css-tricks.com/feed/", category: "frontend", source: "css-tricks", hint: "CSS-Tricks" },
  { url: "https://www.smashingmagazine.com/feed/", category: "frontend", source: "smashing-mag", hint: "Smashing Magazine" },
  { url: "https://blog.logrocket.com/feed/", category: "frontend", source: "logrocket", hint: "LogRocket 前端工程" },
  { url: "https://blog.bitsrc.io/feed", category: "frontend", source: "bitsrc", hint: "Bit.dev 组件化" },
  // —— Node / Backend / 工程 ——
  { url: "https://nodejs.org/en/feed/blog.xml", category: "backend", source: "nodejs-blog", hint: "Node.js 官方" },
  { url: "https://blog.cloudflare.com/rss", category: "backend", source: "cloudflare-blog", hint: "Cloudflare 工程" },
  { url: "https://github.blog/feed/", category: "backend", source: "github-blog", hint: "GitHub 工程博客" },
  { url: "https://stripe.com/blog/feed.rss", category: "backend", source: "stripe-blog", hint: "Stripe 工程" },
  { url: "https://about.gitlab.com/atom.xml", category: "backend", source: "gitlab-blog", hint: "GitLab 工程" },
  // —— AI / Agent / LLM ——
  { url: "https://openai.com/blog/rss.xml", category: "ai", source: "openai-blog", hint: "OpenAI 官方" },
  { url: "https://huggingface.co/blog/feed.xml", category: "ai", source: "hf-blog", hint: "HuggingFace（备用入口）" },
  { url: "https://lilianweng.github.io/feed.xml", category: "ai", source: "lilian-weng", hint: "Lilian Weng / OpenAI" },
  { url: "https://blog.langchain.dev/rss/", category: "ai", source: "langchain-blog", hint: "LangChain 官方（备用入口）" },
  { url: "https://www.anthropic.com/news/rss.xml", category: "ai", source: "anthropic-news", hint: "Anthropic 官方" },
  { url: "https://blog.google/technology/ai/rss/", category: "ai", source: "google-ai", hint: "Google AI" },
  { url: "https://blogs.microsoft.com/ai/feed/", category: "ai", source: "microsoft-ai", hint: "Microsoft AI" },
  // —— 国内技术博客（CN-friendly） ——
  { url: "https://www.infoq.cn/feed.xml", category: "general", source: "infoq-cn", hint: "InfoQ 中文" },
  { url: "https://feed.junyu33.me/", category: "general", source: "rss-aggregate", hint: "聚合源（兜底）" },
];

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // RSS pubDate 可能形如 "Mon, 12 May 2026 10:30:00 GMT"，自动转 string 就行
});

async function fetchTextOrNull(url: string, timeoutMs = 15000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "TechMate-Ingestion/1.0", Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8" },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<img[^>]*>/gi, "[图片]")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface ParsedItem {
  title: string;
  url: string;
  content: string;
  publishedAt?: string;
  author?: string;
}

function extractAtom(parsed: any): ParsedItem[] {
  const entries = parsed?.feed?.entry;
  if (!entries) return [];
  const list = Array.isArray(entries) ? entries : [entries];
  return list.map((e: any) => {
    const linkObj = Array.isArray(e.link) ? e.link[0] : e.link;
    const url = linkObj?.["@_href"] || linkObj || "";
    const contentRaw = e.content?.["#text"] || e.content || e.summary?.["#text"] || e.summary || "";
    return {
      title: (e.title?.["#text"] || e.title || "").toString().trim(),
      url: typeof url === "string" ? url : "",
      content: stripHtml(String(contentRaw)),
      publishedAt: e.published || e.updated,
      author: e.author?.name || "",
    };
  });
}

function extractRss(parsed: any): ParsedItem[] {
  const items = parsed?.rss?.channel?.item;
  if (!items) return [];
  const list = Array.isArray(items) ? items : [items];
  return list.map((it: any) => ({
    title: (it.title || "").toString().trim(),
    url: it.link || it.guid || "",
    content: stripHtml(String(it["content:encoded"] || it.description || "")),
    publishedAt: it.pubDate || it["dc:date"],
    author: it["dc:creator"] || it.author || "",
  }));
}

export class GenericRssAdapter implements IContentAdapter {
  readonly source = "generic-rss";

  async fetch(options: FetchOptions = {}): Promise<Article[]> {
    const limit = options.limit ?? 200;
    const verbose = options.verbose ?? false;

    const all: Article[] = [];

    for (const feed of FEEDS) {
      if (all.length >= limit) break;

      const xml = await fetchTextOrNull(feed.url);
      if (!xml) {
        if (verbose) console.log(`  [generic-rss] ${feed.source} unreachable`);
        continue;
      }

      let parsed: any;
      try {
        parsed = PARSER.parse(xml);
      } catch (e) {
        if (verbose) console.log(`  [generic-rss] ${feed.source} parse error: ${e instanceof Error ? e.message : e}`);
        continue;
      }

      // 优先 atom, 否则 rss
      let items: ParsedItem[] = extractAtom(parsed);
      if (items.length === 0) items = extractRss(parsed);

      let kept = 0;
      for (const it of items) {
        if (all.length >= limit) break;
        if (!it.title || !it.content || it.content.length < 300) continue;

        all.push({
          title: it.title,
          content: it.content,
          source: feed.source,
          sourceUrl: it.url,
          category: feed.category,
          author: it.author || "",
          publishedAt: it.publishedAt,
        });
        kept++;
      }
      if (verbose) console.log(`  [generic-rss] ${feed.source}: kept ${kept}/${items.length}`);
    }

    return all;
  }
}
