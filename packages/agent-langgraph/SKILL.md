---
name: langgraph-agent
description: LangGraph-based multi-turn dialogue agent engine managing conversation state, intent recognition, tool orchestration, and emotional context memory. Supports 3 core scenarios: quick replies (2-3 rounds), task confirmation (3-5 rounds), and emotional support (3-10 rounds). Use when handling user conversations, routing intents, or managing dialogue flow.
metadata:
  category: agent-engine
  version: 1.0.0
  priority: P0
  estimated-days: 3
  triggers: "chat, dialogue, conversation, intent recognition, 对话, 意图识别"
  dependencies: ["core", "mcp-bailian-rag", "mcp-feishu-tasks"]
  dependents: ["web", "scheduler"]
allowed-tools: Read Write Edit Bash(pnpm:*:*)
---

# LangGraph Agent 引擎技能文档

**模块类型**: Agent引擎
**开发状态**: ✅ 已完成
**优先级**: P0
**预计周期**: 3 天

---

## 📖 模块概述

LangGraph Agent 引擎是TechMate 的核心大脑，负责：
- 多轮对话管理
- 意图识别与路由
- 工具调用与编排
- 情感上下文记忆
- 状态持久化

**核心价值**:
- 支持复杂的多轮对话场景（快捷回复、任务确认、情感支持）
- 状态机设计确保对话流程可控
- 集成 MCP 工具（百炼 RAG、飞书任务）

## 当前代码补充（2026-03-26）

除上述基础能力外，当前包内已经额外落地了一个“小红书技术学习经验优先走本地知识”的 MVP：

1. 新增文件：
   - `src/graph/xiaohongshu-rag.ts`
   - `src/graph/xiaohongshu-rag.test.ts`
2. 当前 `generalQANode` 会先判断用户问题是否命中技术学习经验类白名单词。
3. 命中后优先查询本地知识库（`exam_experience`），而不是实时搜索小红书。
4. 若本地无结果或检索失败，再自动降级回普通通用回答。

这意味着当前 Agent 已具备“离线沉淀知识优先、实时抓取兜底最小化”的检索路由基础，和项目现阶段“不希望直接实时搜索小红书内容”的约束保持一致。

---

## 🎯 核心功能

### 功能1: 多轮对话状态机

**功能描述**: 使用 LangGraph StateGraph 管理对话状态。

**状态结构**:
```typescript
interface GraphStateType {
  userId: string;
  messages: BaseMessage[];
  userIntent: UserIntent;
  waitingForUserInput: boolean;
  quickReplyOptions: string[];
  ragResults: any[];
  feishuTaskIds: string[];
  emotionContext?: EmotionContext;
}
```

**支持的场景**:
1. **早晚推送快捷回复** (2-3轮)
   - 发送问候 → 用户选择快捷回复 → 调整计划/确认

2. **任务创建确认流程** (3-5轮)
   - 生成任务计划 → 用户确认/调整 → 创建飞书任务

3. **情感支持深度对话** (3-10轮)
   - 识别情绪 → 深度对话 → 情感疏导 → 记录上下文

---

### 功能2: 意图识别节点

**功能描述**: 识别用户意图并路由到相应节点。

**支持意图**:
- `greeting`: 早安/晚安问候
- `create_task`: 创建/调整学习任务
- `query_progress`: 查询学习进度
- `emotion_support`: 表达负面情绪/寻求支持
- `general_qa`: 一般性问题咨询

**实现方式**:
```typescript
// 使用 LLM 进行意图识别
const intentPrompt = `
分析以下用户消息的意图，返回以下之一：
- greeting: 早安/晚安问候
- create_task: 创建/调整学习任务
- query_progress: 查询学习进度
- emotion_support: 表达负面情绪/寻求支持
- general_qa: 一般性问题咨询

用户消息：${content}

只返回意图名称，不要其他内容。
`;
```

---

### 功能3: 早晚问候节点

**早安问候节点**:
- 时间：每天 8:00
- 内容：个性化问候 + 今日学习建议
- 快捷回复选项：
  - "开始今天的学习" → 进入任务生成
  - "调整学习计划" → 进入计划调整
  - "查看学习进度" → 进入进度查询

**晚间复盘节点**:
- 时间：每天 22:00
- 内容：今日学习总结 + 明日计划预告
- 快捷回复选项：
  - "记录今天的学习心得" → 记录学习笔记
  - "查看本周数据" → 跳转到数据看板
  - "准备休息" → 结束对话

---

### 功能4: 任务生成节点

**功能描述**: 根据用户需求生成个性化学习任务。

**流程**:
1. 分析用户当前学习状态
2. 调用百炼 RAG 检索相关经验
3. 生成任务计划（模块、数量、难度）
4. 等待用户确认
5. 调用飞书任务 MCP 创建任务

**交互示例**:
```
AI: 根据你最近的学习情况，我建议这周重点攻克数量关系。
    计划：每天 20 题，中等难度，预计 7 天完成。
    [确认计划] [调整任务]

用户: 调整任务

AI: 好的，你想要如何调整？
    [减少题量] [增加难度] [延长周期]

用户: 减少题量

AI: 没问题，调整为每天 15 题，预计 9 天完成。
    [确认计划] [继续调整]

用户: 确认计划

AI: 太好了！正在为你创建飞书任务...
    任务创建成功！🎉
```

---

### 功能5: 情感支持节点

**功能描述**: 识别用户情绪，提供情感疏导。

**触发条件**:
- 关键词识别：焦虑、压力、放弃、挫败等
- 学习异常检测：连续3天未学习、正确率持续下降

**支持策略**:
1. **共情回应**: 理解用户的感受
2. **经验分享**: 调用 RAG 检索类似经历的解决方案
3. **建议引导**: 提供具体的改进建议
4. **正向激励**: 鼓励用户继续坚持

**示例对话**:
```
用户: 学习一直卡在65分，感觉很难突破了...

AI: 我理解你的感受，瓶颈期确实让人沮丧。😔
    很多考友都经历过这个阶段，让我帮你看看有什么方法...

    [调用百炼 RAG 检索经验]

    根据学习经验，突破的关键在于：
    1. 薄弱模块专项突破（而不是全面撒网）
    2. 错题复盘，找出规律
    3. 模拟练习训练时间分配

    要不要我帮你分析一下你的薄弱模块？
    [分析薄弱模块] [制定突破计划] [我再想想]
```

---

## 🔧 技术实现

### 技术栈

- @langchain/langgraph: LangGraph 状态机
- @langchain/core: LangChain 核心
- @langchain/anthropic: Anthropic LLM
- @tech-mate/core: 核心类型和工具
- @tech-mate/mcp-bailian-rag: 百炼 RAG MCP
- @tech-mate/mcp-feishu-tasks: 飞书任务 MCP

### 代码结构

```
src/
├── graph/
│   ├── state.ts              # GraphState 定义
│   ├── nodes.ts              # 节点定义
│   ├── edges.ts              # 边定义
│   └── graph.ts              # 图构建
├── tools/
│   ├── mcp-tools.ts          # MCP 工具封装
│   └── local-tools.ts        # 本地工具
├── prompts/
│   ├── system-prompts.ts     # 系统提示词
│   └── task-prompts.ts       # 任务提示词
├── middleware/
│   ├── emotion-detector.ts   # 情感检测
│   └── context-enhancer.ts   # 上下文增强
├── config/
│   └── agent.config.ts       # Agent 配置
└── index.ts                  # 入口文件
```

---

## 🔌 接口定义

### HTTP API

| 端点 | 方法 | 参数 | 返回值 | 说明 |
|------|------|------|--------|------|
| /api/agent/chat | POST | message, userId, state | AgentResponse | 对话接口 |
| /api/agent/state | GET | userId | GraphStateType | 获取状态 |
| /api/agent/reset | POST | userId | void | 重置对话 |

### AgentResponse 结构

```typescript
interface AgentResponse {
  response: string;              // AI 回复内容
  quickReplies?: string[];       // 快捷回复选项
  waitingForInput: boolean;      // 是否等待用户输入
  state?: GraphStateType;        // 当前状态（用于恢复）
}
```

---

## 📝 依赖关系

### 依赖的模块

- `@tech-mate/core`: 类型定义、提示词、工具
- `@tech-mate/mcp-bailian-rag`: RAG 检索工具
- `@tech-mate/mcp-feishu-tasks`: 任务管理工具

### 被依赖的模块

- `@tech-mate/web`: 前端调用 Agent API
- `@tech-mate/scheduler`: 定时任务调用 Agent

---

## 🚀 开发指南

### 本地开发

```bash
# 进入目录
cd packages/agent-langgraph

# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建
pnpm build

# 启动 Agent 服务
pnpm start
```

### 环境变量配置

```bash
# .env 文件
ANTHROPIC_API_KEY=your_anthropic_api_key
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=your_langchain_api_key
LANGCHAIN_PROJECT=civil-service-agent
```

### LangSmith 可视化调试

```bash
# 设置环境变量
export LANGCHAIN_TRACING_V2=true
export LANGCHAIN_API_KEY=your_key

# 运行 Agent
pnpm start

# 访问 LangSmith 查看状态机执行轨迹
# https://smith.langchain.com/
```

---

## 📋 待办事项

- [x] 定义 GraphState 状态结构 (0.5天)
- [x] 实现意图识别节点 (0.5天)
- [x] 实现早晚问候节点 (0.5天)
- [x] 实现任务生成节点 (0.5天)
- [x] 实现情感支持节点 (0.5天)
- [x] 集成 MCP 工具 (0.5天)

---

## 📚 使用示例

### 前端调用示例

```typescript
// Web 前端调用 Agent
async function chatWithAgent(message: string) {
  const response = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      userId: 'user-123'
    })
  });

  const data = await response.json();

  // 显示 AI 回复
  console.log(data.response);

  // 显示快捷回复按钮
  if (data.quickReplies) {
    renderQuickReplies(data.quickReplies);
  }

  // 保存状态（用于下次请求恢复）
  if (data.waitingForInput) {
    saveState(data.state);
  }
}
```

### 调度器调用示例

```typescript
// 早安问候任务
import { AgentClient } from "@tech-mate/agent-langgraph";

const agent = new AgentClient();

async function morningGreeting(userId: string) {
  const result = await agent.chat({
    message: "TRIGGER_MORNING_GREETING",
    userId
  });

  // 发送推送通知
  await sendPushNotification({
    userId,
    title: "早上好！☀️",
    body: result.response,
    quickReplies: result.quickReplies
  });
}
```

---

## 🎓 最佳实践

1. **状态管理**: 始终保存 `state` 并在下次请求时恢复
2. **快捷回复**: 优先引导用户使用快捷回复，提升体验
3. **错误处理**: 捕获 LLM 和 MCP 调用错误，提供友好提示
4. **性能优化**: 缓存常见问题的回复，减少 LLM 调用
5. **日志记录**: 记录每个节点的执行时间，便于优化

---

## 🔍 调试技巧

### 查看状态机执行轨迹

1. 访问 LangSmith: https://smith.langchain.com/
2. 选择项目: civil-service-agent
3. 查看最近的执行记录
4. 点击每个节点查看详细输入输出

### 本地测试节点

```typescript
// 测试意图识别节点
import { intentRecognitionNode } from "./nodes";

const state = {
  messages: [new HumanMessage("帮我制定学习计划")]
};

const result = await intentRecognitionNode(state);
console.log("意图:", result.userIntent);
```

### 性能分析

```bash
# 使用 time 命令测量执行时间
time pnpm start

# 查看 LangSmith 中的节点耗时
# 找出慢节点进行优化
```

---

## 📊 状态机流程图

```
┌─────────────────────────────────────────────────────────────┐
│                    START (用户消息)                          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  intent_recognition  │  意图识别节点
              └──────────┬───────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
    morning_greeting  generate_task  emotion_support
         │               │               │
         ▼               ▼               ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │发送问候 │    │生成任务 │    │情感疏导 │
    │+快捷回复│    │+确认流程│    │+RAG检索│
    └─────────┘    └─────────┘    └─────────┘
         │               │               │
         └───────────────┼───────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   generate_response  │  生成最终回复
              └──────────┬───────────┘
                         │
                         ▼
                    ┌─────────┐
                    │   END   │
                    └─────────┘
```

---

## 📝 更新日志

### v1.1.0 (2026-01-30)

**新增功能**:
- ✅ 支持流式输出（Streaming）
- ✅ 多轮对话记忆功能
- ✅ 欢迎消息自动显示

**技术改进**:
- 将所有节点改造为流式节点（AsyncGenerator）
- 修复流式生成器的迭代器处理逻辑
- 在流式节点中传递完整的历史消息
- 优化状态管理和消息持久化

**修复的问题**:
- 修复 `instanceof AIMessage` 检查失败的问题
- 修复流式节点返回值获取失败的问题
- 修复多轮对话记忆丢失的问题

**影响的文件**:
- `src/graph/nodes.ts`: 所有流式节点实现
- `src/graph/graph.ts`: 流式处理逻辑
- `packages/web/src/hooks/use-agent.ts`: 前端流式处理
- `packages/web/src/app/api/agent/chat/route.ts`: API 流式响应

---

**文档版本**: v1.1
**最后更新**: 2026-01-30
**维护者**: sxh
