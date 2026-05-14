import { Article } from "../types";

/**
 * 关键词白名单 — 命中任一才算技术内容
 * 标题或前 300 字符必须命中
 */
const KEYWORDS = [
  // 前端
  "react", "vue", "next", "nuxt", "svelte", "angular", "typescript", "javascript",
  "前端", "组件", "hook", "ssr", "csr", "webpack", "vite", "esbuild", "rollup",
  "css", "tailwind", "样式", "动画", "响应式",
  // 后端 & 工程
  "node", "express", "nest", "koa", "后端", "服务端", "api", "rest", "graphql",
  "数据库", "mysql", "postgres", "redis", "mongodb", "sqlite", "orm", "prisma",
  "架构", "微服务", "云", "docker", "kubernetes", "k8s",
  // 算法 & 工程
  "算法", "数据结构", "leetcode", "性能优化", "工程",
  // AI / Agent / RAG
  "ai", "agent", "llm", "大模型", "向量", "embedding", "rag", "langchain", "langgraph",
  "openai", "claude", "chatgpt", "gpt", "transformer", "fine-tune", "prompt",
  "deepseek", "qwen", "anthropic", "mistral", "gemini",
  // 通用技术
  "性能", "缓存", "并发", "异步", "网络", "安全", "测试", "ci/cd", "devops",
];

/**
 * 中文比例：用于过滤纯英文小说之类的噪音
 */
function chineseRatio(text: string): number {
  if (!text) return 0;
  const matches = text.match(/[一-鿿]/g);
  return matches ? matches.length / text.length : 0;
}

export interface FilterOptions {
  minLength?: number;       // 默认 300
  maxLength?: number;       // 默认 12000
  minChineseRatio?: number; // 默认 0（允许全英文）
  requireKeyword?: boolean; // 默认 true
  /**
   * 时效性过滤：发布日期距今超过 N 天的文章直接淘汰。
   * 默认 0 = 关闭。常见取值：730 (≈ 2 年)、365 (1 年)
   */
  maxAgeDays?: number;
  /**
   * 时效性过滤的严格度：true 时缺失 publishedAt 视为过期；false（默认）时透传
   * - 前端技术演进快，缺日期的文章一般来自较老的 adapter，可考虑严格
   * - 部分源（如 awesome list）本身就没有"发布日期"概念，建议宽松
   */
  strictAge?: boolean;
}

/**
 * 解析多种 publishedAt 格式 → Date | null
 * 支持：ISO 8601、Unix timestamp、毫秒 timestamp、常见 RSS pubDate
 */
function parsePublishedAt(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    // 10 位 = 秒级，13 位 = 毫秒级
    const d = new Date(value < 1e12 ? value * 1000 : value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export class ArticleFilter {
  constructor(private readonly opt: FilterOptions = {}) {}

  accept(article: Article): { ok: boolean; reason?: string } {
    const content = article.content || "";
    const title = article.title || "";

    const minLen = this.opt.minLength ?? 300;
    const maxLen = this.opt.maxLength ?? 30000;

    if (content.length < minLen) {
      return { ok: false, reason: `too_short(${content.length}<${minLen})` };
    }
    if (content.length > maxLen) {
      return { ok: false, reason: `too_long(${content.length}>${maxLen})` };
    }

    const minCn = this.opt.minChineseRatio ?? 0;
    if (minCn > 0) {
      const ratio = chineseRatio(content);
      if (ratio < minCn) {
        return { ok: false, reason: `low_chinese_ratio(${ratio.toFixed(2)})` };
      }
    }

    if (this.opt.requireKeyword ?? true) {
      const sample = (title + " " + content.slice(0, 300)).toLowerCase();
      const hit = KEYWORDS.some((kw) => sample.includes(kw));
      if (!hit) {
        return { ok: false, reason: "no_keyword" };
      }
    }

    // 时效性过滤 —— 内容时效短，老文章误导风险高
    const maxAgeDays = this.opt.maxAgeDays ?? 0;
    if (maxAgeDays > 0) {
      const publishedAt = parsePublishedAt(article.publishedAt);
      if (publishedAt) {
        const ageDays = (Date.now() - publishedAt.getTime()) / 86400_000;
        if (ageDays > maxAgeDays) {
          return { ok: false, reason: `too_old(${Math.round(ageDays)}d>${maxAgeDays}d)` };
        }
      } else if (this.opt.strictAge) {
        // 严格模式：缺失日期直接淘汰
        return { ok: false, reason: "no_published_at" };
      }
      // 宽松模式（默认）：缺失日期透传，由 source 信任度决定
    }

    return { ok: true };
  }
}
