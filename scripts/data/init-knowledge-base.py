#!/usr/bin/env python3
"""
TechMate 知识库初始化脚本
直接使用 ChromaDB Python SDK 初始化数据
"""

import chromadb
import requests
import json
import sys
import os

# 设置 API Key
EMBEDDING_API_KEY = os.environ.get("EMBEDDING_API_KEY", "sk-2b9b8a96b1af4c7196a713d768b4d468")
EMBEDDING_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding"

# 知识数据
KNOWLEDGE_DATA = [
    # Agent 知识 (10条)
    {
        "content": "Agent 核心概念\n\n什么是 AI Agent？\nAgent 是一种能够自主决策、调用工具、完成复杂任务的智能代理系统。与普通 LLM 对话不同，Agent 具备自主决策能力、工具调用能力、循环执行能力。\n\nAgent 与普通 LLM 的区别：\n- 普通 LLM：输入 → 输出文本\n- Agent：输入 → 分析 → 调用工具 → 观察结果 → 继续执行 → 最终输出",
        "metadata": {"title": "Agent 核心概念", "source": "TechMate 知识库", "category": "agent"}
    },
    {
        "content": "LangChain Agent 架构\n\nLangChain Agent 采用三层架构：\n1. Agent（决策引擎）- 负责分析用户输入，决定调用哪个工具\n2. Tools（工具集）- 定义 Agent 可调用的外部能力\n3. AgentExecutor（执行器）- 编排 Agent 的执行流程\n\n执行流程：初始化 → Agent.decide() → 执行工具 → 观察结果 → 继续或结束",
        "metadata": {"title": "LangChain Agent 架构", "source": "TechMate 知识库", "category": "agent"}
    },
    {
        "content": "Tool Calling 原理\n\nFunction Calling 是 LLM 调用外部工具的核心机制：\n1. 工具注册 - 将工具定义注册到 LLM，包含参数 Schema\n2. LLM 决策 - 分析用户输入，决定是否调用工具\n3. 参数解析 - 从 LLM 输出中提取工具名称和参数\n4. 工具执行 - 调用实际工具函数\n5. 结果回传 - 将工具结果返回给 LLM继续生成",
        "metadata": {"title": "Tool Calling 原理", "source": "TechMate 知识库", "category": "agent"}
    },
    {
        "content": "Agent 类型对比\n\nLangChain 提供多种 Agent 类型：\n1. ZeroShotAgent - 零样本决策，适合工具数量少的场景\n2. ConversationalAgent - 支持多轮对话，适合客服助手\n3. ReActAgent - 推理+行动循环，适合复杂推理任务\n4. StructuredToolAgent - 支持多参数，适合 API 调用",
        "metadata": {"title": "Agent 类型对比", "source": "TechMate 知识库", "category": "agent"}
    },
    {
        "content": "ReAct 推理模式\n\nReAct = Reasoning + Acting\n核心循环：Thought → Action → Observation\n\n1. Thought（推理）- Agent 分析当前状态\n2. Action（行动）- 根据推理结果选择工具\n3. Observation（观察）- 获取工具执行结果\n4. 继续循环或结束\n\nReAct 优势：决策过程透明，便于调试",
        "metadata": {"title": "ReAct 推理模式", "source": "TechMate 知识库", "category": "agent"}
    },
    {
        "content": "多 Agent 协作\n\n复杂任务需要多个 Agent 协作：\n1. 任务分解 - 将复杂任务分解为子任务\n2. Agent 间通信 - 通过共享状态或消息传递\n3. 协作模式 - 顺序协作、并行协作、层级协作\n\n应用场景：数据处理流水线、客服系统",
        "metadata": {"title": "多 Agent 协作", "source": "TechMate 知识库", "category": "agent"}
    },
    {
        "content": "Agent 记忆机制\n\nAgent 需要记忆系统保持上下文：\n1. 短期记忆 - 存储当前对话上下文\n2. 长期记忆 - 将历史对话存储到向量数据库\n3. 记忆检索策略 - 时间窗口、重要性筛选、语义检索",
        "metadata": {"title": "Agent 记忆机制", "source": "TechMate 知识库", "category": "agent"}
    },
    {
        "content": "Agent 规划能力\n\n复杂任务需要 Agent 进行规划：\n1. 任务分解（Plan-and-Execute）- 将大任务分解为有序子任务\n2. 动态规划 - 根据执行结果动态调整\n3. 执行顺序优化 - 分析依赖关系，并行执行",
        "metadata": {"title": "Agent 规划能力", "source": "TechMate 知识库", "category": "agent"}
    },
    {
        "content": "Agent 常见问题\n\n常见问题及解决方案：\n1. 工具选择错误 - 优化工具描述，控制工具数量\n2. 死循环问题 - 设置最大循环次数，添加早停条件\n3. 幻觉错误决策 - 使用 RAG 提供真实上下文\n4. 任务偏离 - 明确目标，验证每步是否偏离",
        "metadata": {"title": "Agent 常见问题", "source": "TechMate 知识库", "category": "agent"}
    },
    {
        "content": "Agent 实战案例\n\n案例一：智能客服 Agent\n场景：用户查询订单状态、处理退款\n架构：意图识别 Agent + 订单查询 Tool + 退款处理 Tool\n\n案例二：数据分析 Agent\n场景：自动获取数据、分析、生成报告\n架构：数据获取 Tool + 分析计算 Tool + 可视化 Tool",
        "metadata": {"title": "Agent 实战案例", "source": "TechMate 知识库", "category": "agent"}
    },
    # RAG 知识 (12条)
    {
        "content": "RAG 核心原理\n\nRAG = Retrieval-Augmented Generation，检索增强生成\n通过检索外部知识增强 LLM 的生成能力\n\nRAG 与微调的区别：\n- 微调：更新模型参数，适合特定风格适配\n- RAG：检索外部知识，适合动态知识问答\n\nRAG 优势：知识实时更新、减少幻觉、可追溯、成本低",
        "metadata": {"title": "RAG 核心原理", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "RAG 流程详解\n\n完整流程五步骤：\n1. Query - 用户输入问题\n2. Embedding - 将查询转换为向量\n3. Retrieval - 在向量数据库中检索相似文档\n4. Prompt 构建 - 将检索结果构建为 Prompt\n5. Generation - LLM 基于 Prompt 生成答案",
        "metadata": {"title": "RAG 流程详解", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "向量数据库对比\n\n主流向量数据库：\n- Chroma：轻量级、易部署、本地优先\n- Pinecone：云托管、高性能、免运维\n- Milvus：开源、分布式、高性能\n- Qdrant：Rust 实现、高性能\n\n选型建议：开发用 Chroma，生产用 Pinecone，大规模用 Milvus",
        "metadata": {"title": "向量数据库对比", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "向量检索原理\n\nEmbedding 向量化：将文本转换为高维向量（如 1536 维）\n向量语义特性：相似文本向量相近，不同文本向量远离\n\n相似度计算：\n- Cosine Similarity（余弦相似度）- 推荐\n- Euclidean Distance（欧氏距离）\n- Dot Product（点积）",
        "metadata": {"title": "向量检索原理", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "BM25 关键词检索\n\nBM25 是经典的关键词检索算法\n核心要素：TF（词频）、IDF（逆文档频率）、文档长度归一化\n\nBM25 vs 向量检索：\n- BM25：关键词精确匹配，无语义理解\n- 向量检索：语义相似度，同义扩展强\n\n中文 BM25 需要分词（jieba/pkuseg）",
        "metadata": {"title": "BM25 关键词检索", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "Hybrid 混合检索\n\nHybrid = 向量检索 + BM25 关键词检索\n融合算法 - RRF（Reciprocal Rank Fusion）\n\n实现流程：\n1. 并行执行向量检索和 BM25 检索\n2. 各返回 topK 结果\n3. 使用 RRF 融合排名\n4. 返回融合后的 topN 结果",
        "metadata": {"title": "Hybrid 混合检索", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "Re-ranking 重排\n\n两阶段检索架构：\n第一阶段：粗检索（快速，大量候选）\n第二阶段：重排序（精细，少量候选）\n\n常用重排模型：BGE-M3（多语言）、Cohere Rerank（云 API）\n重排流程：candidates → reranker → topN",
        "metadata": {"title": "Re-ranking 重排", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "LlamaIndex 概述\n\nLlamaIndex 是专门为 RAG 设计的数据框架\n定位：连接自定义数据源到 LLM\n\n核心组件：\n1. Reader - 数据读取\n2. Index - 索引构建\n3. Retriever - 检索执行\n4. QueryEngine - 查询引擎",
        "metadata": {"title": "LlamaIndex 概述", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "LlamaIndex vs LangChain\n\n核心定位差异：\n- LlamaIndex：数据框架，索引构建、检索优化\n- LangChain：Agent 编排框架，Chain、Tool、Memory\n\n适用场景：\n- LlamaIndex：文档问答、知识库\n- LangChain：Agent 应用、多步骤任务\n\n协同使用：LangChain 编排 + LlamaIndex 检索",
        "metadata": {"title": "LlamaIndex vs LangChain", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "知识库构建\n\n关键步骤：\n1. 数据收集 - 内部文档、外部数据、用户数据\n2. 文档切分（Chunking）- Chunk Size 500-1000，Overlap 10-20%\n3. 元数据添加 - source、category、title\n4. 向量化存储",
        "metadata": {"title": "知识库构建", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "RAG 常见问题\n\n问题一：检索召回不足 - Embedding 不适配，知识库覆盖不全\n问题二：幻觉问题 - 强化 Prompt 指令，添加来源引用\n问题三：知识库更新延迟 - 增量索引，定期重建",
        "metadata": {"title": "RAG 常见问题", "source": "TechMate 知识库", "category": "rag"}
    },
    {
        "content": "RAG 优化策略\n\n三级检索策略：\n1. Precise - 高度匹配（阈值 >0.8）\n2. Candidates - 中等匹配（0.5-0.8）\n3. Expand - 泛化检索\n4. Fallback - 兜底返回\n\nQuery 改写：扩展关键词、补充上下文",
        "metadata": {"title": "RAG 优化策略", "source": "TechMate 知识库", "category": "rag"}
    },
    # LangChain 知识 (9条)
    {
        "content": "LangChain 核心概念\n\nLangChain 是 LLM 应用开发框架\n核心组件：\n1. Chain - 串联执行多个组件\n2. Tool - 定义外部能力\n3. Memory - 保持对话上下文\n4. Prompt Template - 结构化 Prompt",
        "metadata": {"title": "LangChain 核心概念", "source": "TechMate 知识库", "category": "langchain"}
    },
    {
        "content": "Chain 编排模式\n\nChain 编排模式：\n1. SimpleChain - 单一组件执行\n2. SequentialChain - 多链顺序执行\n3. RouterChain - 动态选择子链\n4. TransformChain - 数据转换",
        "metadata": {"title": "Chain 编排模式", "source": "TechMate 知识库", "category": "langchain"}
    },
    {
        "content": "Tool 工具机制\n\nLangChain Tool 定义规范：\n- name: 工具名称（唯一）\n- description: 描述（Agent 依据此选择）\n- func: 执行函数\n\nStructuredTool 支持多参数和 Schema 定义\n设计原则：单一职责、描述清晰、错误处理",
        "metadata": {"title": "Tool 工具机制", "source": "TechMate 知识库", "category": "langchain"}
    },
    {
        "content": "Memory 记忆系统\n\nLangChain Memory 类型：\n1. ConversationBufferMemory - 存储完整对话\n2. ConversationBufferWindowMemory - 只保留最近 N 条\n3. ConversationSummaryMemory - 历史压缩为摘要\n4. VectorStoreMemory - 向量检索历史",
        "metadata": {"title": "Memory 记忆系统", "source": "TechMate 知识库", "category": "langchain"}
    },
    {
        "content": "Prompt Template\n\nPrompt Template 结构化定义：\n- 变量命名清晰：{role} {question} {context}\n- 包含角色定义\n- Few-shot 示例引导输出格式\n- 输出格式约束",
        "metadata": {"title": "Prompt Template", "source": "TechMate 知识库", "category": "langchain"}
    },
    {
        "content": "LangGraph 状态图\n\nLangGraph 状态编排扩展\n核心概念：\n1. StateGraph - 定义状态和节点\n2. Node - 处理逻辑\n3. Edge - 节点间流转\n4. Loop - 循环控制\n\n适用场景：Agent 循环执行、多步骤任务",
        "metadata": {"title": "LangGraph 状态图", "source": "TechMate 知识库", "category": "langchain"}
    },
    {
        "content": "LangSmith 调试\n\nLangChain 调试追踪平台\n核心功能：\n1. Trace 追踪 - 完整执行链路\n2. Agent 行为调试 - Thought/Action/Observation\n3. 性能分析 - Token 消耗分布",
        "metadata": {"title": "LangSmith 调试", "source": "TechMate 知识库", "category": "langchain"}
    },
    {
        "content": "LCEL 管道语法\n\nLangChain Expression Language\n基础语法：prompt | model | outputParser\nRunnable 接口：invoke()、batch()、stream()、map()\n优势：代码简洁、组件可组合、类型安全",
        "metadata": {"title": "LCEL 管道语法", "source": "TechMate 知识库", "category": "langchain"}
    },
    {
        "content": "LangChain 最佳实践\n\n最佳实践：\n1. Chain 拆分原则 - 单一职责\n2. 错误处理 - callbacks handleError\n3. 版本管理 - Prompt 模板版本化\n4. 性能优化 - 缓存、批量处理\n5. 测试策略 - Prompt/Chain/Agent 测试",
        "metadata": {"title": "LangChain 最佳实践", "source": "TechMate 知识库", "category": "langchain"}
    },
    # 大模型知识 (9条)
    {
        "content": "大模型基础概念\n\nTransformer 架构：Encoder + Decoder + Attention\n预训练：学习通用语言能力\n参数规模：GPT-3 175B、Claude ~200B、Llama-2 7B-70B\n\n模型类型：\n- Base Model：预训练模型\n- Instruction Model：指令微调\n- Chat Model：对话优化",
        "metadata": {"title": "大模型基础概念", "source": "TechMate 知识库", "category": "llm"}
    },
    {
        "content": "Prompt Engineering\n\n提示词设计技巧：\n1. 明确角色\n2. 清晰指令\n3. Few-shot 示例\n4. Chain-of-Thought 思维链\n5. 输出格式约束\n6. 约束条件",
        "metadata": {"title": "Prompt Engineering", "source": "TechMate 知识库", "category": "llm"}
    },
    {
        "content": "Token 限制处理\n\nToken 计算：英文约 4 字符 = 1 Token，中文约 1-2 字符 = 1 Token\n超限处理：截断、分段处理、滑动窗口、概要压缩\n最佳实践：预估 Token，留出输出空间",
        "metadata": {"title": "Token 限制处理", "source": "TechMate 知识库", "category": "llm"}
    },
    {
        "content": "幻觉问题\n\n幻觉：LLM 生成与事实不符的信息\n类型：事实错误、资源虚构、逻辑错误\n缓解策略：使用 RAG、降低温度、明确约束、添加校验",
        "metadata": {"title": "幻觉问题", "source": "TechMate 知识库", "category": "llm"}
    },
    {
        "content": "微调 vs RAG\n\n微调：更新模型参数，适合特定风格输出\nRAG：检索外部知识，适合动态知识问答\n\n对比决策：\n- 特定输出风格 → 微调\n- 动态知识更新 → RAG\n- 领域术语适配 → 微调 + RAG",
        "metadata": {"title": "微调 vs RAG", "source": "TechMate 知识库", "category": "llm"}
    },
    {
        "content": "上下文窗口\n\nContext Window 是模型输入限制\n常用窗口：GPT-3.5 4K、GPT-4-turbo 128K、Claude 3 200K\n有效利用：优先级排序、概要先行、分层加载、动态压缩",
        "metadata": {"title": "上下文窗口", "source": "TechMate 知识库", "category": "llm"}
    },
    {
        "content": "模型选型\n\n主流模型对比：\n- GPT-4：能力最强、成本高\n- GPT-3.5：成本低、速度快\n- Claude：窗口大、安全强\n- Qwen：中文强、成本低\n- Llama：开源、可本地部署\n\n选型考虑：任务复杂度、语言场景、成本预算、部署方式",
        "metadata": {"title": "模型选型", "source": "TechMate 知识库", "category": "llm"}
    },
    {
        "content": "流式输出\n\n流式输出实现 Token 级别实时返回\nSSE（Server-Sent Events）实现\nLangChain 流式：model.stream(prompt)\n优势：实时反馈、减少等待感知",
        "metadata": {"title": "流式输出", "source": "TechMate 知识库", "category": "llm"}
    },
    {
        "content": "模型调用最佳实践\n\n最佳实践：\n1. 请求重试机制 - 递增延迟\n2. 超时处理 - Promise.race\n3. 并发控制 - Semaphore\n4. 缓存机制 - 减少重复调用\n5. 成本监控 - Token 消耗追踪",
        "metadata": {"title": "模型调用最佳实践", "source": "TechMate 知识库", "category": "llm"}
    },
]

def get_embedding(text):
    """调用阿里云 DashScope API 获取向量"""
    headers = {
        "Authorization": f"Bearer {EMBEDDING_API_KEY}",
        "Content-Type": "application/json"
    }
    data = {
        "model": "text-embedding-v2",
        "input": {"texts": [text]},
        "parameters": {"text_type": "document"}
    }
    response = requests.post(EMBEDDING_API_URL, headers=headers, json=data, timeout=30)
    result = response.json()
    if "output" in result and "embeddings" in result["output"]:
        return result["output"]["embeddings"][0]["embedding"]
    else:
        raise Exception(f"Embedding API error: {result}")

def main():
    print("=" * 50)
    print("TechMate 知识库初始化")
    print("=" * 50)

    # 初始化 ChromaDB（连接 HTTP Server）
    print("\n[1] 初始化 ChromaDB...")
    client = chromadb.HttpClient(host='localhost', port=8000)

    # 创建或获取 collection（使用 cosine 余弦相似度）
    print("\n[2] 创建 tech_knowledge collection...")
    collection = client.get_or_create_collection(
        name="tech_knowledge",
        metadata={
            "description": "Tech knowledge base for RAG",
            "hnsw:space": "cosine"  # 关键：使用余弦相似度（范围 0-1）
        }
    )

    # 检查现有数据
    existing_count = collection.count()
    print(f"    现有记录数: {existing_count}")

    if existing_count > 0:
        print("\n[!] Collection 已有数据，跳过初始化")
        print(f"    如需重新初始化，请先删除 collection")
        return

    # 生成向量并添加文档
    print("\n[3] 生成向量并添加文档...")
    ids = []
    embeddings = []
    metadatas = []
    documents = []

    for i, doc in enumerate(KNOWLEDGE_DATA):
        print(f"    处理文档 {i+1}/{len(KNOWLEDGE_DATA)}: {doc['metadata']['title']}")
        try:
            embedding = get_embedding(doc["content"])
            ids.append(f"doc-{i+1}")
            embeddings.append(embedding)
            metadatas.append(doc["metadata"])
            documents.append(doc["content"])
        except Exception as e:
            print(f"    ❌ 处理失败: {e}")
            continue

    # 批量添加
    print("\n[4] 写入 ChromaDB...")
    collection.add(
        ids=ids,
        embeddings=embeddings,
        metadatas=metadatas,
        documents=documents
    )

    # 验证
    print("\n[5] 验证数据...")
    final_count = collection.count()
    print(f"    最终记录数: {final_count}")

    print("\n" + "=" * 50)
    print("✅ 知识库初始化完成")
    print("=" * 50)

if __name__ == "__main__":
    main()