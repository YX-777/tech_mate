/**
 * GuardRail 三层防护统一入口
 *
 * 三层防护：
 *   L1 InputGuard  → 用户输入端注入检测（规则+启发式）
 *   L2 ToolGuard   → 工具参数 Zod 校验 + 危险参数黑名单
 *   L3 OutputGuard → 输出相关性 + 幻觉交叉验证（异步、不阻塞）
 *
 * 设计要点：
 *   - 每一层独立可用、独立可关
 *   - 每一层结果都附带 OTel span + AgentEvent，可 Dashboard / JSONL 回溯
 *   - 没有 LLM 二次调用，0 token 0 等待延迟
 *
 * 设计思路（一句话）：
 *   harness-engineering — 在 Agent 的每个边界放一个守门员：
 *   输入挡注入，工具挡危险参数，输出做相关性 + 幻觉抽样验证，全部接入 OTel。
 */

export * from "./types";
export { DEFAULT_POLICIES, SSRF_INTERNAL_PATTERN } from "./policies";
export { checkInput } from "./input-guard";
export type { InputGuardOptions } from "./input-guard";
export { checkToolInvocation, listGuardedTools } from "./tool-guard";
export type { ToolGuardOptions } from "./tool-guard";
export { checkOutput, extractFactualClaims, computeFactCoverage } from "./output-guard";
export type { OutputGuardInput, RAGSourceSnippet } from "./output-guard";
