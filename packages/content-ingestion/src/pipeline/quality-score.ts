/**
 * 内容质量评分（0-1 加权求和）
 *
 * 多维度评分 —— 用于在已通过 filter 的文章里再做"宁缺毋滥"排序/筛选。
 *
 * 维度（权重见 WEIGHTS）：
 *  - 长度归一化（length）：1000-5000 字得满分，过短/过长降权
 *  - 关键词密度（keywordDensity）：技术词占比越高分越高
 *  - 来源权重（source）：一手源 > 二手源
 *  - 标题质量（title）：含技术专有名词 + 长度合理
 *  - 结构性（structure）：含代码块 / 列表 / 表格 / 多段落
 *
 * 阈值经验值 0.5 —— 低于此值的内容被 filter，建议跟 length filter 配合
 */

import { Article } from "../types";

const WEIGHTS = {
  length: 0.25,
  keywordDensity: 0.30,
  source: 0.20,
  title: 0.15,
  structure: 0.10,
} as const;

/** 一手技术博客 / 教程类源给高权重；社区 / 周刊给中等；论坛低 */
const SOURCE_WEIGHTS: Record<string, number> = {
  "hf-blog": 1.0,
  "langchain-blog": 1.0,
  awesome: 0.85,
  devto: 0.75,
  ruanyf: 0.6,
  "ruanyf-weekly": 0.6,
  weekly: 0.6,
  xiaohongshu: 0.5,
  unknown: 0.5,
};

/** 技术关键词（quality 评分用，可以比 filter 的白名单更窄/更"核心"） */
const TECH_KEYWORDS = [
  "react", "vue", "next.js", "typescript", "javascript", "hook", "useeffect",
  "node", "express", "nest", "graphql", "rest", "api",
  "docker", "kubernetes", "k8s",
  "ai", "llm", "agent", "rag", "embedding", "vector",
  "langchain", "langgraph", "openai", "claude", "gpt",
  "前端", "后端", "架构", "性能", "缓存", "并发", "异步", "工程",
  "组件", "状态管理", "渲染", "构建",
  "算法", "数据结构",
];

export interface QualityScoreDetail {
  total: number;
  length: number;
  keywordDensity: number;
  source: number;
  title: number;
  structure: number;
}

/**
 * 三角形归一化：在 [lo, hi] 区间内得满分，两边线性衰减
 */
function trapezoidalScore(value: number, lo: number, sweetLo: number, sweetHi: number, hi: number): number {
  if (value <= lo || value >= hi) return 0;
  if (value >= sweetLo && value <= sweetHi) return 1;
  if (value < sweetLo) return (value - lo) / (sweetLo - lo);
  return (hi - value) / (hi - sweetHi);
}

function scoreLength(content: string): number {
  // 甜区 1000-5000 字
  return trapezoidalScore(content.length, 200, 1000, 5000, 30000);
}

function scoreKeywordDensity(text: string): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of TECH_KEYWORDS) {
    if (lower.includes(kw)) hits++;
  }
  // 命中 8 个以上算饱和；3 个以下分数低
  return Math.min(hits / 8, 1);
}

function scoreSource(source?: string): number {
  if (!source) return SOURCE_WEIGHTS.unknown;
  const key = source.toLowerCase();
  // 精确匹配 → 包含匹配 → 兜底
  if (SOURCE_WEIGHTS[key] !== undefined) return SOURCE_WEIGHTS[key];
  for (const [k, w] of Object.entries(SOURCE_WEIGHTS)) {
    if (key.includes(k)) return w;
  }
  return SOURCE_WEIGHTS.unknown;
}

function scoreTitle(title?: string): number {
  const t = (title || "").trim();
  if (!t) return 0;
  // 长度 8-50 是甜区
  const lenScore = trapezoidalScore(t.length, 3, 8, 50, 120);
  // 含技术关键词 → 加分
  const lower = t.toLowerCase();
  const hasTechKeyword = TECH_KEYWORDS.some(kw => lower.includes(kw));
  return Math.min(lenScore + (hasTechKeyword ? 0.3 : 0), 1);
}

function scoreStructure(content: string): number {
  if (!content) return 0;
  let s = 0;
  // 含代码块（```）→ +0.4
  if (/```[\s\S]*?```/.test(content)) s += 0.4;
  else if (/`[^`]+`/.test(content)) s += 0.15; // 内联代码也算半个
  // 含有序/无序列表（连续 2 行以上的 - 或 数字. ）→ +0.3
  if (/(^|\n)[\-*]\s.+\n[\-*]\s.+/.test(content)) s += 0.3;
  else if (/(^|\n)\d+\.\s.+\n\d+\.\s.+/.test(content)) s += 0.3;
  // 多段落（≥ 4 段）→ +0.3
  const paragraphs = content.split(/\n{2,}/).filter(p => p.trim().length >= 30);
  if (paragraphs.length >= 4) s += 0.3;
  else if (paragraphs.length >= 2) s += 0.15;
  return Math.min(s, 1);
}

/**
 * 计算文章质量分（0-1）+ 各维度细分
 */
export function scoreArticle(article: Article): QualityScoreDetail {
  const content = article.content || "";
  const title = article.title || "";

  const length = scoreLength(content);
  const keywordDensity = scoreKeywordDensity(`${title}\n${content.slice(0, 1500)}`);
  const source = scoreSource(article.source);
  const titleScore = scoreTitle(title);
  const structure = scoreStructure(content);

  const total =
    WEIGHTS.length * length +
    WEIGHTS.keywordDensity * keywordDensity +
    WEIGHTS.source * source +
    WEIGHTS.title * titleScore +
    WEIGHTS.structure * structure;

  return {
    total: Number(total.toFixed(3)),
    length: Number(length.toFixed(3)),
    keywordDensity: Number(keywordDensity.toFixed(3)),
    source: Number(source.toFixed(3)),
    title: Number(titleScore.toFixed(3)),
    structure: Number(structure.toFixed(3)),
  };
}

/**
 * 默认阈值 —— 0.5。配合 filter 用：filter 过的内容再 score，再卡阈值
 */
export const DEFAULT_QUALITY_THRESHOLD = 0.5;
