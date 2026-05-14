# TechMate 项目指南

## 项目概述

TechMate 是一个 AI 技术学习陪伴 Agent，帮助前端开发者系统化提升技术能力。

**核心技术能力**：
1. LangGraph 多节点对话路由 + SSE 流式响应
2. 混合分层 RAG 检索（Chroma + BM25 + RRF + BGE-M3 重排 + 三级策略）
3. 四阶分层记忆系统（instant / short / long / meta）
4. MCP 自动化采集链路（多源技术内容）
5. GuardRail 三层防护（输入 / 工具 / 输出）
6. OpenTelemetry 全链路可观测（JSONL + Trace Viewer）

---

## 启动命令

```bash
# 一键启动全部服务（本地开发）
bash scripts/dev/start.sh

# 一键停止
bash scripts/dev/stop.sh

# 首次运行初始化（依赖 + 数据库 + 默认用户）
bash scripts/dev/init-first-run.sh

# 仅初始化数据库
bash scripts/dev/init-db.sh
```

服务端口：

| 服务 | 地址 |
| --- | --- |
| Web | http://localhost:3000 |
| ChromaDB Server | http://localhost:8000 |
| ChromaDB Web UI | http://localhost:3001 |
| MCP 服务 | http://localhost:3002 |

---

## 项目结构

```
packages/
├── web/                 # Next.js 14 前端 + API Routes
├── agent-langgraph/     # LangGraph Agent 核心（StateGraph / Memory / GuardRail / OTel）
├── rag-engine/          # 混合 RAG 检索引擎（含 LlamaIndex 适配层）
├── database/            # 数据库服务（Prisma + SQLite + ChromaDB）
├── content-ingestion/   # 多源知识库采集
├── scheduler/           # 定时任务（早安 / 周同步 / 异常巡检）
├── mcp-bailian-rag/     # MCP 服务（阿里百炼 RAG）
├── mcp-xiaohongshu/     # MCP 服务（小红书内容）
├── mcp-feishu-tasks/    # MCP 服务（飞书任务）
└── core/                # 共享常量 / 配置 / 日志

scripts/
├── dev/        # 本地开发启停
├── data/       # 知识库 bootstrap / 数据迁移
└── deploy/     # Linux 部署 / systemd / swap / update

chroma-web-ui/  # ChromaDB 可视化前端（独立 Next 项目）
docker/         # Dockerfile / docker-compose / nginx
docs/           # 架构设计文档
```

---

## 关键文件速查

| 功能 | 文件路径 |
| --- | --- |
| Agent 节点定义 | `packages/agent-langgraph/src/graph/nodes.ts` |
| StateGraph 构建 | `packages/agent-langgraph/src/graph/graph.ts` |
| 混合 RAG（LlamaIndex 适配层） | `packages/rag-engine/src/llamaindex/` |
| 四阶分层记忆 | `packages/agent-langgraph/src/memory/` |
| GuardRail 三层 | `packages/agent-langgraph/src/guardrail/` |
| OTel JSONL Exporter | `packages/agent-langgraph/src/otel/` |
| 多源内容采集 | `packages/content-ingestion/` |
| 知识库 bootstrap | `scripts/data/bootstrap-kb.sh` |
| ChromaDB Server | `scripts/dev/start-chroma.py` |

---

## 开发规范

### Git 提交
- commit message 简短（一行）
- 推送前需用户确认

### 代码风格
- TypeScript，中文注释
- 避免过度抽象，三处相似优于过早抽象

### 复杂功能开发流程
对于复杂功能（如分层记忆、GuardRail 防护等），写代码前：
1. **先进入 plan 模式** —— 讨论技术方案、架构设计
2. **大白话解释原理** —— 用通俗易懂的语言说清楚为什么
3. **确认后再实现** —— 避免返工

---

## 环境配置

关键环境变量（`packages/web/.env`）：

| 变量 | 说明 |
| --- | --- |
| `DASHSCOPE_API_KEY` | 阿里云百炼 API Key（embedding + LLM） |
| `VECTOR_DB_PATH` | ChromaDB 地址（默认 `http://localhost:8000`） |
| `DATABASE_URL` | SQLite 路径（默认 `file:./data/tech-mate.db`） |

---

## 常见问题

### ChromaDB 连接失败
先启动 ChromaDB Server：
```bash
bash scripts/dev/start.sh         # 一键启动全部
python3 scripts/dev/start-chroma.py  # 仅 ChromaDB
```

### RAG 检索返回空
访问 http://localhost:3001 检查 ChromaDB 是否有数据，或运行：
```bash
python3 scripts/data/init-knowledge-base.py
# 或者全量 bootstrap：
bash scripts/data/bootstrap-kb.sh
```

