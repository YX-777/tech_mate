export interface UsedSource {
  type: "memory" | "kb" | "web";   // 🧠 对话记忆 / 📚 本地知识库 / 🌐 联网搜索
  title: string;
  detail?: string;
  url?: string;
  score?: number;
}

/**
 * 执行轨迹（思考过程）：基于 LangGraph 节点真实执行步骤生成。
 * 比模型 reasoning_content 更简洁可控，是 Agent 调用链路的实时可观测视图。
 */
export interface ExecutionStep {
  id: string;                                     // memory / rag / web / generate
  label: string;
  icon: string;
  status: "running" | "done" | "skip";
  detail?: string;
}

/**
 * 单层防护状态 —— 统一三（四）态。
 * 设计原则：N/A 必须诚实标 skip，**绝不伪装成 pass**（这是项目核心诚实叙事，
 * 早期 L3 存在"伪装通过"问题，后给 L3 打了 applied 补丁，现收编为统一模型）。
 *   pass  = 本层确实运行了且通过
 *   block = 本层确实运行了且**拦截了本次请求**（决定性，徽章据此做标题）
 *   warn  = 本层运行了，标了告警但不阻断（L3 异步观测层）
 *   skip  = 本场景本层未运行 / 无对象可校验（灰显，绝不计为通过）
 */
export type GuardLayerState = "pass" | "block" | "warn" | "skip";

export interface GuardLayerResult {
  state: GuardLayerState;
  detail?: string;                 // 一句话诚实说明
  hits?: number;
  maxRisk?: string;
  // L2 专属：被拦截的工具调用明细
  blocks?: Array<{
    tool: string;
    maxRisk: string;
    hits: Array<{ ruleId: string; reason: string; risk: string; matchedText?: string }>;
  }>;
  // L3 专属
  similarity?: number;
  factCoverage?: number;
}

export interface GuardRailSummary {
  input: GuardLayerResult;
  tool: GuardLayerResult;
  output: GuardLayerResult;
}

export interface GuardRailBlockInfo {
  layer: string;             // "input" | "tool" | "output"
  maxRisk: string;           // "high" / "medium" / ...
  hits: Array<{
    ruleId: string;
    ruleName: string;
    risk: string;
    reason: string;
    matchedText?: string;
  }>;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  thoughts?: string;          // AI 思考过程（已弃用，保留兼容）
  steps?: ExecutionStep[];    // 执行轨迹
  sources?: UsedSource[];     // 本次回答引用的来源
  guardrail?: GuardRailSummary;     // 🛡️ 三层防护结果
  traceId?: string;                 // OTel TraceId（可在 Trace Viewer 回溯）
  guardrailBlock?: GuardRailBlockInfo; // 🚫 该消息被 GuardRail 拦截，渲染告警卡片
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  userId: string;
}

export interface QuickReply {
  id: string;
  text: string;
  action: string;
}

export interface Stats {
  totalHours: number;
  avgAccuracy: number;
  consecutiveDays: number;
  completedTasks: number;
  progressPercentage: number;
  studyDays?: number;
  remainingDays?: number | null;
  accuracyTrend?: Array<{
    date: string;
    accuracy: number;
  }>;
  modules?: Array<{
    name: string;
    accuracy: number;
    totalQuestions: number;
    correctAnswers: number;
  }>;
  suggestion?: {
    level: "info" | "warning" | "success";
    title: string;
    description: string;
  };
}

export interface Task {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "completed" | "overdue";
  progress: number;
  dueDate: string;
  description?: string | null;
  module?: string | null;
  difficulty?: string | null;
  actualMinutes?: number;
  estimatedMinutes?: number;
  completedAt?: string | null;
  createdAt?: string;
  source?: "manual" | "agent";
}

export interface UserProfile {
  nickname: string;
  totalStudyDays: number;
}

export interface LongTermMemoryItem {
  id: string;
  content: string;
  contentType: string;
  weight: number;
  accessCount: number;
  topics: string[];
  creationDate: string | null;
  lastAccessed: string | null;
}

export interface XhsDetailErrorBreakdown {
  access_denied: number;
  transient: number;
  parse_empty: number;
  login_required: number;
  invalid_param: number;
  lookup_miss?: number;
  unknown: number;
}

export interface XhsSyncRunSummary {
  id: string;
  status: string;
  requestedLimit: number;
  fetchedCount: number;
  insertedCount: number;
  dedupedPostIdCount: number;
  dedupedHashCount: number;
  invalidCount: number;
  failedCount: number;
  detailErrorCount: number;
  detailErrorBreakdown: XhsDetailErrorBreakdown;
  createdAt: string;
  endedAt?: string | null;
}

export interface XhsPostReportItem {
  postId: string;
  title: string;
  authorName?: string | null;
  keyword?: string | null;
  status: string;
  errorCategory?: string | null;
  likeCount: number;
  commentCount: number;
  publishTime?: string | null;
  updatedAt: string;
  sourceUrl?: string | null;
  contentPreview: string;
  errorMessage?: string | null;
}

export interface XhsSyncDashboardData {
  summary: {
    totalRuns: number;
    successRuns: number;
    failedRuns: number;
    totalPosts: number;
    newPosts: number;
    detailUnavailablePosts: number;
  };
  latestRun: XhsSyncRunSummary | null;
  recentRuns: XhsSyncRunSummary[];
  recentPosts: XhsPostReportItem[];
  runTrend: Array<{
    label: string;
    fetchedCount: number;
    insertedCount: number;
    detailErrorCount: number;
    transient: number;
    parseEmpty: number;
    accessDenied: number;
    unknown: number;
  }>;
  keywordStats: Array<{
    keyword: string;
    totalPosts: number;
    availablePosts: number;
    detailUnavailablePosts: number;
  }>;
}
