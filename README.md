<h1 align="center">TechMate</h1>

<p align="center">
  <em>面向前端开发者的 AI 技术学习陪伴 Agent</em>
</p>

<p align="center">
  <a href="#核心能力"><img alt="LangGraph" src="https://img.shields.io/badge/Agent-LangGraph-6366f1"></a>
  <a href="#核心能力"><img alt="RAG" src="https://img.shields.io/badge/RAG-LlamaIndex%20+%20Chroma%20+%20BM25-22c55e"></a>
  <a href="#核心能力"><img alt="Memory" src="https://img.shields.io/badge/Memory-4--Tier-a78bfa"></a>
  <a href="#guardrail"><img alt="GuardRail" src="https://img.shields.io/badge/GuardRail-3--Layer-f59e0b"></a>
  <a href="#observability"><img alt="OTel" src="https://img.shields.io/badge/Observability-JSONL%20Tracing-0ea5e9"></a>
  <a href="#许可证"><img alt="License" src="https://img.shields.io/badge/license-MIT-000000"></a>
</p>

TechMate 是一个 AI 技术学习陪伴 Agent。通过对话帮前端开发者梳理学习路径、解答技术问题、生成可执行的学习任务；用户在使用过程中沉淀下来的偏好与技术背景会持久化为"个人记忆"，长期形成专属知识档案。

项目把 AI 应用工程里几个常见模块按生产标准做了实现：**LangGraph 多节点对话编排 / LlamaIndex 适配的混合 RAG / 四阶分层记忆 / 三层 GuardRail / OpenTelemetry 风格 JSONL Trace / 多档 LLM 路由**。每条链路都有对应的 UI 入口可以回放追溯。

---

## 在线体验

- **本地启动**：`bash scripts/dev/start.sh` 后访问 `http://localhost:3000`
- **典型链路**：Chat 发 _"帮我规划 React 3 天学习计划"_ → 流式表格输出 → 点"确认计划" → 任务页生成 3 条子任务 → 完成任务后 Profile 页"个人记忆"沉淀。

---

## 核心能力

### 🧭 LangGraph 多节点对话编排

基于官方 `StateGraph` 构建，从 `START` 经 `intent_recognition` 条件路由分发到 `task_generation` / `rag_query` / `emotion_support` / `general_qa` / `progress_query` 等节点，全程 SSE 流式回写：

- 每个节点的进入 / 退出 / 工具调用都会作为 **step 事件** 推到前端，对应 UI 上一条"执行轨迹"
- 流式期间实时展示，结束后折叠成概览，可点击展开复盘
- 节点级别失败兜底（如 RAG 命中率为 0 时回退到 `general_qa`）
- 通过 `SqliteSaver` 实现 LangGraph 标准 Checkpoint 持久化，进程重启后会话状态可恢复

> 文件：`packages/agent-langgraph/src/graph/{graph,nodes,edges,state}.ts`

### 🔍 混合分层 RAG（LlamaIndex 适配层）

在 LlamaIndex 的 `BaseRetriever` / `BaseNodePostprocessor` / `RetrieverQueryEngine` 抽象上重新组织，单一 `LlamaIndexQueryEngine` 串起整条检索链：

| 阶段 | 实现 | 角色 |
| --- | --- | --- |
| Embedding | `DashScopeEmbedding` | 阿里百炼 `text-embedding-v2`（1536 维），区分 doc / query 两种 text_type |
| Vector 检索 | `LlamaVectorRetriever` | ChromaDB 余弦相似度 |
| BM25 检索 | `LlamaBM25Retriever` | 首次使用时从 Chroma 拉全量文档 lazy 建索引 |
| 融合 | `HybridFusionRetriever` | RRF 融合（k = 60） |
| 重排 | `BgeM3NodePostprocessor` | 阿里百炼 `gte-rerank` 二轮精排 |
| 合成 | `ThreeTierSynthesizer` | 三级响应（高置信直答 / 中置信引用源 / 低置信兜底） |

知识库通过 `content-ingestion` 多源采集（**1900+ 条**）：

- **dev.to API**（20 个技术标签）
- **GitHub awesome READMEs**（30 个精选仓库）
- **25 个技术 RSS feed**（Vercel / Next.js / Mozilla / OpenAI / Anthropic / Cloudflare / GitHub Blog 等）

所有条目带 `source_url` 回链，前端"参考来源"卡片可点开原文。质量管线用 **SimHash 64-bit** 去重 + 5 维加权评分 + 近 2 年发布时间过滤。

**离线评估结果**（30 题 × 4 大主题分布在 1942 条语料上）：

| 配置 | Recall@10 | Precision@5 | MRR |
| --- | --- | --- | --- |
| 纯向量 | 96.7% | 21.3% | 0.927 |
| 向量 + BM25 + RRF | 91.7% | 21.3% | 0.834 |
| 全链路（+ BGE-M3 重排） | 91.7% | 21.3% | 0.834 |

幻觉率（10 题 × LLM-as-judge 三轮平均）：**No-RAG 74.6% → Full-RAG 16.4%**（≈ 4.5× 改善）。

> 评估脚本：`packages/rag-engine/scripts/run-rag-eval.ts`，结果落 `scripts/eval/results.json`，方法学详见 `scripts/eval/README.md`。

### 🧠 四阶分层记忆

仿照人类记忆模型分四层独立存取、按需融合：

```
instant   (内存滑窗，~10 条) ─┐
short     (SQLite 衰减)     │   ─► fusion (并行检索 + 加权合并) ─► prompt 注入
long      (ChromaDB 向量加权) ─┤
meta      (元记忆 / 用户画像)  ─┘
```

- **fact-extractor**：用户主动声明 + LLM 自动提取双通道直写长期记忆
- **reinforce**：高频话题强化分数，自动从 short 归档到 long
- **新鲜度衰减**：时间衰减 + 反复使用复活，避免越老越权威

> 文件：`packages/agent-langgraph/src/memory/{instant,short,long,meta,fusion,reinforce,fact-extractor}.ts`

### 🛡️ GuardRail 三层防护 <a id="guardrail"></a>

在 Agent 的每个边界放一个守门员，全部基于规则 + 嵌入相似度计算，**0 LLM 调用 0 token 成本**：

| 层 | 入口 | 核心策略 | 失败动作 |
| --- | --- | --- | --- |
| **L1 输入** | 用户消息入口 | 8 条注入模式（中英文 ignore / DAN / 角色扮演伪 system / Markdown 注入 / system prompt 泄露 / 密钥套取） | 400 拦截，返回 `GUARDRAIL_BLOCKED` |
| **L2 工具** | 工具调用前 | Zod schema + 黑名单（SQL 注入 / Shell 注入 / SSRF / 内网地址 / `file://`） | 拒绝该次工具调用，记录命中规则 |
| **L3 输出** | LLM 输出后异步 | Jaccard CJK-aware 相关性 + 启发式事实抽取 vs RAG 来源交叉验证 | 仅记录 + UI 徽章告警，不阻塞流式 |

通过的对话在消息卡片下方显示"🛡️ 已通过 3 层防护"折叠徽章，含 sim / factCoverage 指标。

> 文件：`packages/agent-langgraph/src/guardrail/{input,tool,output}-guard.ts` + `policies.ts`

### 📊 JSONL 全链路 Trace <a id="observability"></a>

`AsyncLocalStorage` 隐式上下文 + `withSpan` 高阶函数，所有 node / tool / LLM / GuardRail 调用都落一个 span：

- **JSONL 落盘**：`logs/traces/{conversationId}.jsonl`，按 conversation 切分，grep 即可复盘
- **Trace Viewer**（Dashboard 右上）：按 conversationId 拉取 JSONL，瀑布图展示完整调用链
- **Dashboard 实时指标**：会话数 / RAG 命中率 / Agent 事件类型分布 / GuardRail L1 L2 L3 通过率

Span 结构与字段命名遵循 OpenTelemetry 约定（`trace_id` / `span_id` / `parent_span_id` / `attributes`），后续接 OTLP collector 只需替换 exporter。

> 文件：`packages/agent-langgraph/src/otel/{instrumentation,exporters/jsonl-exporter,async-context}.ts`

### 🎚️ 多档 LLM 路由

按任务复杂度动态选择模型档位，在效果和成本之间做平衡：

| 档位 | 默认模型 | 适用任务 |
| --- | --- | --- |
| T1 | `qwen-turbo-latest` | 意图识别 / 事实抽取 / 快捷回复（短链路高频） |
| T2 | `qwen-plus` | 通用问答 / 三级响应合成（主力档位） |
| T3 | `qwen-max` | 学习任务规划（推理密度高、调用低频） |

通过环境变量 `LLM_MODEL_T1/T2/T3` 覆盖默认模型，`LLM_BASE_URL_T1/T2/T3` 覆盖入口。同一 DashScope `api_key` 可跨模型复用，未来切换其他兼容 OpenAI API 的供应商只需改 baseURL。

> 文件：`packages/agent-langgraph/src/llm/{router,client,types}.ts`

### 🪪 任务规划闭环

Chat 里 _"帮我规划 React 学习计划，3 天周期"_ → 流式输出 markdown 表格 → 点"确认计划" → 后端按 `periodDays` 拆 N 条子任务写入 `/tasks` → 回复中带 `👉 [前往任务页查看](/tasks)` 跳转链接 → 用户在任务页完成 → fire-and-forget 异步写长期记忆 → Profile "个人记忆" 沉淀。

> 文件：`packages/web/src/app/api/agent/chat/route.ts` + `packages/web/src/app/api/tasks/[id]/complete/route.ts`

---

## 架构

```
                 ┌────────────────────────────────────┐
                 │     Next.js 14 (App Router)        │
                 │  Chat / Dashboard / Tasks / Profile│
                 │  Trace Viewer · SSE Streaming      │
                 └────────────────┬───────────────────┘
                                  │ SSE
                 ┌────────────────▼───────────────────┐
                 │       Agent API (Route Handler)    │
                 │   GuardRail L1 → LangGraph → L3    │
                 └────────────────┬───────────────────┘
                                  │
                 ┌────────────────▼───────────────────┐
                 │     LangGraph StateGraph           │
                 │  intent → task / rag / qa / emotion│
                 │  + 4-tier Memory + OTel Span       │
                 │  + SqliteSaver Checkpoint          │
                 └────┬──────┬──────┬─────────┬───────┘
                      │      │      │         │
                      ▼      ▼      ▼         ▼
                  Memory   RAG    Web      LLM 多档路由
                 (SQLite  (Chroma  Search   (T1 turbo
                  +Vector +BM25    Serper    /T2 plus
                  +Meta)  +Rerank) /Tavily)  /T3 max)
```

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Next.js 14（App Router）、React 18、Ant Design、Tailwind |
| Agent | LangGraph 0.0.x、LangChain Core |
| RAG | LlamaIndex 0.11、ChromaDB、BM25（natural）、阿里百炼 `gte-rerank` |
| Memory | Prisma + SQLite（短期 / 元）、ChromaDB（长期向量） |
| LLM | DashScope qwen-turbo / qwen-plus / qwen-max（OpenAI 兼容模式） |
| Embedding | DashScope `text-embedding-v2`（1536 维） |
| Search | Serper.dev / Tavily（双 provider 互为备份） |
| Observability | 自研 OTel-style JSONL exporter + 自研 Trace Viewer |
| 工程 | pnpm workspaces、TypeScript 5、tsx、tsup |

---

## 快速开始

### 1. 依赖

```bash
node --version    # ≥ 18
pnpm --version    # ≥ 8
python3 --version # ≥ 3.10（ChromaDB 运行时）
```

### 2. 安装与初始化

```bash
git clone <repo>
cd <repo>

# 配置环境变量（DASHSCOPE_API_KEY 必填）
cp packages/web/.env.example packages/web/.env
# 编辑 packages/web/.env

# 首次初始化（依赖 + Prisma + 数据库 + 默认用户）
bash scripts/dev/init-first-run.sh
```

### 3. 启动

```bash
bash scripts/dev/start.sh
# 浏览器打开 http://localhost:3000
```

### 4.（可选）灌入知识库

```bash
# 最小集（40 条 curated 知识）
python3 scripts/data/init-knowledge-base.py

# 全量 bootstrap（1900+ 条多源采集）
bash scripts/data/bootstrap-kb.sh
```

---

## 项目结构

```
techmate/
├── packages/
│   ├── web/                 # Next.js 前端 + API Routes
│   ├── agent-langgraph/     # LangGraph Agent 核心（含 LLM 路由 / Memory / GuardRail / OTel）
│   ├── rag-engine/          # 混合 RAG（含 LlamaIndex 适配层）
│   ├── database/            # Prisma + SQLite + ChromaDB 客户端
│   ├── content-ingestion/   # 多源知识库采集（RSS / GitHub awesome / dev.to）
│   ├── scheduler/           # 定时任务（早安推送 / 周同步 / 异常巡检）
│   ├── mcp-xiaohongshu/     # 小红书内容采集 MCP 服务
│   └── core/                # 共享常量 / 配置 / 日志
├── scripts/
│   ├── dev/                 # 本地开发启停
│   ├── data/                # 知识库 bootstrap / 数据导出导入
│   ├── eval/                # RAG 离线评估集 + 结果
│   └── deploy/              # Linux 部署 / systemd / swap
├── chroma-web-ui/           # ChromaDB 可视化前端（独立 Next 项目）
├── docker/                  # Dockerfile / docker-compose / nginx
└── docs/                    # 架构设计文档
```

每个 `packages/*` 都是独立 npm 包，通过 pnpm workspace 联动；包间使用 `@tech-mate/*` 命名空间。

---

## 部署

`scripts/deploy/` 下有完整的 Linux 部署链路：

```bash
sudo bash scripts/deploy/init-linux.sh        # 装 Node / pnpm / Python / ChromaDB / swap
sudo bash scripts/deploy/deploy-linux.sh      # 一键部署 + systemd
bash scripts/deploy/update-server.sh          # 每次发版热更新
```

Docker 方案见 `docker/DEPLOY.md`。

---

## 许可证

[MIT](./LICENSE)
