/**
 * Agent LangGraph 入口文件
 */

export { createAgentGraph } from "./graph/graph";
export { createInitialState } from "./graph/state";
export { getAgentConfig, validateAgentConfig } from "./config/agent.config";
export { getMCPToolClient } from "./tools/mcp-tools";
export { getEmotionDetector } from "./middleware/emotion-detector";
export { getContextEnhancer } from "./middleware/context-enhancer";
export { retrieveWithFallback, inferCategoryFromQuery } from "./utils/rag-fallback";
export { extractAndPersistFacts, matchExplicitFacts, persistTaskCompletionFact, persistFocusCompletionFact } from "./memory/fact-extractor";
export { getReviewRecommendations, formatReviewBlock, type ReviewItem } from "./memory/review-recommender";

// GuardRail 三层防护
export {
  checkInput,
  checkToolInvocation,
  checkOutput,
  listGuardedTools,
  extractFactualClaims,
  computeFactCoverage,
  DEFAULT_POLICIES,
} from "./guardrail";
export type {
  GuardLayer,
  GuardResult,
  GuardHit,
  RiskLevel,
  InputGuardOptions,
  ToolGuardOptions,
  OutputGuardInput,
  RAGSourceSnippet,
} from "./guardrail";

// OpenTelemetry 可观测模块
export {
  TraceContext,
  Span,
  startTrace,
  endTrace,
  createTraceContext,
  getLogger,
  runInTrace,
  getCurrentTrace,
  withSpan,
  withSpanGen,
  readTraceForConversation,
  listTracedConversations,
} from "./otel";

export type { GraphStateType, EmotionContext, PendingTaskPlan } from "./graph/state";
export type { AgentConfig } from "./config/agent.config";
export type { RAGFallbackResult } from "./utils/rag-fallback";
