# 小红书 MCP 服务

## 概述

小红书 MCP 服务是一个基于 LangChain MCP 适配器的内容抓取工具，用于搜索和获取小红书的内容。该服务通过连接到 `xiaohongshu-mcp` MCP 服务器，提供以下功能：

- 搜索小红书内容
- 获取推荐列表
- 获取帖子详情
- 获取用户主页
- 检查登录状态

## 当前项目内的实际使用口径（2026-03-26）

当前项目接入这个包时，核心目标已经明确为“按关键词搜索技术学习相关内容”，而不是抓首页推荐流。

当前真实用法更接近：

1. 以 `search_feeds` 为主入口：
   - `前端进阶`
   - `技术学习`
   - `项目实战`
   - 以及同类学习经验词
2. 命中结果后再调用 `get_feed_detail` 获取正文与评论。
3. 详情抓取失败时，会在 `scheduler` 层按错误类别决定是否重试。
4. MCP 调用之间会保留固定间隔，避免高频触发风控。

因此本包虽然仍暴露 `list_feeds`，但在当前项目业务链路里，`list_feeds` 已不是主路径。

## 功能特性

### 1. 搜索内容 (`search_feeds`)
根据关键词搜索小红书内容，支持多种筛选条件。

**参数：**
- `keyword` (必需): 搜索关键词
- `sort_by` (可选): 排序依据 - 综合、最新、最多点赞、最多评论、最多收藏
- `note_type` (可选): 笔记类型 - 不限、视频、图文
- `publish_time` (可选): 发布时间 - 不限、一天内、一周内、半年内
- `search_scope` (可选): 搜索范围 - 不限、已看过、未看过、已关注
- `location` (可选): 位置距离 - 不限、同城、附近

**使用场景：**
- 查找特定主题的内容
- 搜索用户笔记
- 发现热门话题

### 2. 获取推荐列表 (`list_feeds`)
获取小红书首页推荐内容列表。

**参数：**
- `page` (必需): 页码，从1开始

**使用场景：**
- 浏览推荐内容
- 发现热门笔记
- 获取最新动态

### 3. 获取帖子详情 (`get_feed_detail`)
获取小红书帖子的完整详情，包括互动数据和评论。

**参数：**
- `feed_id` (必需): 帖子ID
- `xsec_token` (必需): 帖子安全令牌
- `load_all_comments` (可选): 是否加载全部评论，默认false仅返回前10条一级评论
- `limit` (可选): 限制加载的一级评论数量，仅当load_all_comments=true时生效，默认20
- `click_more_replies` (可选): 是否展开二级回复，仅当load_all_comments=true时生效，默认false
- `reply_limit` (可选): 跳过回复数过多的评论，仅当click_more_replies=true时生效，默认10
- `scroll_speed` (可选): 滚动速度，仅当load_all_comments=true时生效，slow|normal|fast，默认normal

**使用场景：**
- 查看帖子详情
- 获取评论内容
- 分析互动数据

**重要提示：**
- 需要提供帖子 ID 和 xsec_token（两个参数缺一不可）
- 这两个参数可以从 Feed 列表或搜索结果中获取
- 必须先登录才能使用此功能

### 4. 获取用户主页 (`get_user_profile`)
获取小红书用户的个人主页信息，包括用户基本信息和笔记内容。

**参数：**
- `user_id` (必需): 用户ID
- `xsec_token` (必需): 用户安全令牌

**使用场景：**
- 查看用户资料
- 获取用户发布的笔记
- 分析用户行为

**重要提示：**
- 需要提供用户 ID 和 xsec_token
- 这两个参数可以从 Feed 列表或搜索结果中获取
- 必须先登录才能使用此功能

### 5. 检查登录状态 (`check_login_status`)
检查小红书登录状态。

**参数：** 无

**使用场景：**
- 验证登录状态
- 确认是否已登录

## 配置

### 环境变量

在 `.env` 文件中配置以下环境变量：

```bash
# 小红书 MCP 服务地址
XIAOHONGSHU_MCP_URL=http://localhost:18060/mcp

# 小红书 MCP 服务超时时间（毫秒）
XIAOHONGSHU_MCP_TIMEOUT=30000

# 是否启用小红书功能（可选）
XIAOHONGSHU_ENABLED=true
```

### MCP 服务要求

在使用小红书 MCP 服务之前，需要：

1. **下载并启动 xiaohongshu-mcp 服务**
   - 从 GitHub Releases 下载对应平台的二进制文件
   - 运行登录工具完成登录：`./xiaohongshu-login-darwin-arm64`
   - 启动 MCP 服务：`./xiaohongshu-mcp-darwin-arm64`

2. **确认服务正常运行**
   - 默认端口：18060
   - MCP 端点：`http://localhost:18060/mcp`

### 项目内启动方式补充

在本仓库内，当前更推荐使用包内脚本而不是手动直接敲二进制命令：

```bash
cd packages/mcp-xiaohongshu
./start.sh
```

补充说明：

1. `start.sh` 已处理后台常驻问题，避免脚本退出后 MCP 进程被一并结束。
2. Web 侧重试接口会在必要时自动尝试拉起该脚本。
3. `GET /mcp` 返回 `405` 不代表服务不可用，只要端口和路由已监听即可视为 MCP 正常可达。

## 使用示例

### 基本使用

```typescript
import { getXiaohongshuMCPClient } from '@tech-mate/mcp-xiaohongshu';

// 获取客户端实例
const client = getXiaohongshuMCPClient();

// 搜索内容
const searchResult = await client.searchFeeds("技术学习经验");

// 获取推荐列表
const listResult = await client.listFeeds(1);

// 获取帖子详情
const detailResult = await client.getFeedDetail(
  "feed_id", 
  "xsec_token"
);

// 获取用户主页
const profileResult = await client.getUserProfile(
  "user_id", 
  "xsec_token"
);

// 检查登录状态
const loginStatus = await client.checkLoginStatus();
```

### 与 LangChain 集成

```typescript
import { getXiaohongshuTools } from '@tech-mate/mcp-xiaohongshu';
import { ChatOpenAI } from '@langchain/openai';

// 创建模型
const model = new ChatOpenAI({
  modelName: "qwen-plus",
  apiKey: process.env.DASHSCOPE_API_KEY,
  configuration: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  },
});

// 获取小红书工具
const tools = getXiaohongshuTools();

// 绑定工具到模型
const modelWithTools = model.bindTools(tools);

// 使用工具
const response = await modelWithTools.invoke([
  new HumanMessage("搜索小红书上关于技术学习经验的内容")
]);
```

## 技术架构

### MCP 适配器

使用 `@langchain/mcp-adapters` 包中的 `MultiServerMCPClient` 来连接小红书 MCP 服务。

### 工具封装

所有小红书功能都封装为 LangChain 的 `StructuredTool`，可以直接与 LangChain 生态集成。

### 错误处理

所有工具都包含完善的错误处理，当调用失败时会抛出详细的错误信息。

## 项目结构

```text
packages/
├── mcp-xiaohongshu/          # 小红书 MCP 客户端包
│   ├── src/
│   │   ├── config/
│   │   │   └── xiaohongshu.config.ts
│   │   ├── client/
│   │   │   └── xiaohongshu-client.ts
│   │   ├── tools/
│   │   │   └── xiaohongshu-tools.ts
│   │   └── index.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── SKILL.md
└── agent-langgraph/
    ├── src/
    │   ├── tools/
    │   │   └── xiaohongshu-tools.ts    # 小红书工具集成
    │   └── config/
    │       └── agent.config.ts
```

## 注意事项

1. **登录状态**
   - 必须先使用 `xiaohongshu-login` 工具完成登录
   - 登录状态会保存在 MCP 服务中

2. **Token 获取**
   - `feed_id` 和 `xsec_token` 可以从搜索结果或推荐列表中获取
   - `user_id` 和 `xsec_token` 可以从帖子详情或搜索结果中获取

3. **性能考虑**
   - 获取帖子详情时，如果不需要全部评论，建议使用默认设置
   - 大量评论加载可能需要较长时间

4. **服务可用性**
   - 确保 xiaohongshu-mcp 服务正在运行
   - 检查网络连接和防火墙设置

## 故障排除

### 连接失败

如果无法连接到 MCP 服务：

1. 检查 xiaohongshu-mcp 服务是否正在运行
2. 确认服务地址配置正确（`XIAOHONGSHU_MCP_URL`）
3. 检查端口是否被占用或被防火墙阻止

### 工具调用失败

如果工具调用失败：

1. 确认已正确登录
2. 检查参数是否正确（特别是 `xsec_token`）
3. 查看服务日志获取详细错误信息

### 性能问题

如果响应速度较慢：

1. 调整超时时间（`XIAOHONGSHU_MCP_TIMEOUT`）
2. 减少加载的评论数量
3. 避免不必要的详情获取

### 联调时前端资源 404（补充）

如果联调时 Web 端出现 `/_next/static/*` 404（即页面打开但静态资源失败）：

1. 优先使用项目根目录统一脚本重启：`./stop-all.sh && ./start-all.sh`
2. 查看日志是否真实输出到：
   - `/tmp/web-service.log`
   - `/tmp/mcp-service.log`
3. 先确认 Web 可达，再确认 `_next` 静态资源可达，避免仅凭首页 200 判断“服务正常”
4. 若仍异常，保留失败 URL 和日志片段，再继续分析是否为进程退出或缓存问题

## 测试

### 运学习试脚本

```bash
# 在 mcp-xiaohongshu 目录下
node test.mjs
```

### 测试内容

测试脚本会依次执行以下测试：

1. ✅ 检查登录状态
2. ✅ 获取推荐列表
3. ✅ 搜索内容

## 参考资料

- [xiaohongshu-mcp GitHub 仓库](https://github.com/xpzouying/xiaohongshu-mcp)
- [LangChain MCP 适配器文档](https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain_mcp_adapters)
- [小红书 API 文档](https://open.xiaohongshu.com/)
