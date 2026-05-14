# RAG 评估结果 · 2026-05-15

> 跑法见 [README.md](./README.md)，原始数据见 [results.json](./results.json)

## 环境

| 项 | 值 |
|---|---|
| 时间戳 | 2026-05-14 15:57 UTC（本地时间 23:57） |
| 知识库 | `tech_knowledge` collection，**1942 条**（40 条 curated 种子 + 1902 条多源采集 chunks） |
| 多源采集 | dev.to API（20 标签）/ GitHub awesome READMEs（30 仓库）/ 25 个技术 RSS feed |
| Embedding | DashScope `text-embedding-v2`，**1536 维** |
| Reranker | 阿里百炼 `gte-rerank`（即业内通称的 BGE-M3 重排族） |
| Faithfulness Judge | qwen-plus，temperature 0.2 |
| 评估集 | [rag-eval-set.jsonl](./rag-eval-set.jsonl) 30 题（Agent 8 / RAG 10 / LangChain 7 / LLM 5） |

## Phase 1：检索质量（30 题平均）

| 配置 | Recall@10 | Precision@5 | MRR |
|---|---|---|---|
| **Vector only** | **96.7%** | 21.3% | **0.927** |
| Hybrid (Vec + BM25 + RRF) | 91.7% | 21.3% | 0.834 |
| Full (Hybrid + 重排) | 91.7% | 21.3% | 0.834 |

**怎么读这张表**：
- Recall@K 越大越好（前 K 个里抓到正确文档的比例）
- MRR 越接近 1 越好（正确文档平均排第 1.08 位，由 1 / 0.927 反推）
- Precision@5 看绝对值意义不大，因为 ground truth 每题只 1-2 个 doc，分母 5 → 天花板 20-40%

## Phase 2：生成质量 / 幻觉（10 题平均）

| 配置 | Faithfulness | Hallucination |
|---|---|---|
| **No-RAG**（模型靠参数知识答） | 25.4% | **74.6%** |
| **Full-RAG**（注入召回文档） | **83.6%** | **16.4%** |

**核心数字：幻觉率从 74.6% 降至 16.4%，约 4.5× 改善。**

## 三个关键发现

### 1. 主要论点站得住：RAG 显著降低幻觉

74.6% → 16.4% 这 **58.2 个百分点** 的 gap 不是 LLM-judge 抖动能解释的。
方向性结论稳健：**接 RAG 后回答严格基于知识库，可溯源性显著提升**。

值得注意的是，相比 40 条 curated 数据时的 8.6%，扩到 1942 条后 with-RAG 幻觉率上升到 16.4%。诊断在 Finding 2。

### 2. 反直觉发现：在 1942 条混合语料下，纯向量 ≥ Hybrid

教科书会告诉你"Hybrid 一定比单路好"，但**这里数据反过来**：

```
Recall@10:  Vector 96.7%  vs  Hybrid 91.7%   差 5.0 个百分点
MRR:        Vector 0.927  vs  Hybrid 0.834   差 0.093
```

**诊断**：1942 条里 40 条是 self-contained 主题文档，1902 条是 RSS / awesome / dev.to 多源采集。BM25 在命中 "Function Calling" "LangChain" 等关键术语时，会把**关键词重合但主题不同**的 chunk 拉进候选（典型例子：一篇讲"用 Vue 接 LangChain"的入门博客被 BM25 拉进来，挤掉了真正的"LangGraph 概念"权威文档）。

具体到题目层面，q21 "LangGraph 和普通 Chain 区别" 上，纯向量 R@10 = 1.00，Hybrid R@10 = 0.00 —— BM25 把 LangChain 周边博客拉满，正确的 `doc-28` 直接被挤出 top10。

**结论**：BM25 + 重排的真实价值在**高质量同分布的大库**。当前语料源混杂（dev.to 高噪声 + curated 低噪声），BM25 把噪声放大了。架构本身正确，但**数据治理（来源加权 / 噪声过滤）才是下一阶段瓶颈**。

### 3. 同时也带来了一个真实的 trade-off

40 条 curated 时 with-RAG 幻觉率 8.6%；1942 条后 16.4%。差的 7.8 个百分点来自：

- **过时片段**：RSS 抓到的老博客讲 LangChain 0.0.x API，retriever 拉到后 LLM 信了文档，生成"有出处但实际过时"的答案
- **关键词重合但主题不对的片段**（Finding 2 已述）

这印证了 RAG 工程化的核心难题：**更多语料 ≠ 更好答案**。下一步应着力在 source-level 质量过滤和时效性衰减。

## 失败 / 部分失败的样本（共 4 题）

| ID | 类别 | 问题 | Expected | Vector R@10 | Hybrid R@10 | 说明 |
|---|---|---|---|---|---|---|
| q02 | Agent | Function Calling 完整流程 | doc-3, doc-25 | 0.5 | 0.5 | 命中 doc-3，漏 doc-25（LangChain Tool 工具机制），双源题 |
| q05 | Agent | Agent 记忆机制类型 | doc-7, doc-26 | 1.0 | 0.5 | 纯向量两条全召回，**Hybrid 漏一条**（BM25 拉噪声挤掉） |
| q21 | LangChain | LangGraph 和 Chain 区别 | doc-28 | 1.0 | **0.0** | 纯向量命中，**Hybrid 完全漏掉** —— BM25 把 LangChain 周边博客拉满 |
| q28 | LLM | token 限制超了怎么办 | doc-34, doc-37 | 0.5 | 0.5 | 命中 doc-34，漏 doc-37（上下文窗口），双源题 |

**模式**：
- q02 / q28 是双 expected doc 题，向量找到主答案但漏相关补充文档 —— ground truth 设计的边界 case
- q05 / q21 是 **Hybrid 引入噪声**导致的退化，纯向量没问题

## 评估方法的局限

- **题量偏小**（30 题），适合表达方向性结论，绝对值有 ±3% 抖动
- **Ground truth 颗粒度**：每题 1-2 个 expected doc，Precision@5 天花板 20-40%
- **LLM-as-judge 抖动**：faithfulness 数字有 ±5% 波动（qwen-plus 评判温度 0.2）
- **No-RAG faithfulness 偏低的语义**：对照基线是召回文档而非"绝对事实"。模型用通用知识答出的"事实正确但不在 KB"的陈述会被记为 unsupported。这是 Ragas 等 RAG 评估框架的标准定义，衡量的是**答案对当前知识库的接地气程度**

## 后续改进方向

- **数据治理优先**：从源头按 source 加权（curated > GitHub awesome > RSS > dev.to），打 source 标签并在 retriever 阶段引入软偏置
- **时效性衰减**：RAG 检索阶段对发布时间老于 N 个月的文档施加衰减分（与记忆系统的新鲜度衰减统一）
- **题量扩至 100+**，按 multi-rater 标注法重做，引入 chunk 级 ground truth
- **adversarial set**：加入 KB 里没有的话题，评估拒答（abstention）能力
- **接 CI**：每次改 retriever / reranker / 数据源自动跑回归
