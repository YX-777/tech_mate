/**
 * GuardRail 默认策略 —— 配置中心，方便审计 / 调整
 *
 * 设计原则：
 *   1. 规则可枚举（黑名单 / 模式），不依赖 LLM 二次判断 → 0 token 0 延迟
 *   2. 中英文双语覆盖（多语种）
 *   3. 分级触发，HIGH 直接拒绝，MEDIUM 脱敏，LOW 仅记录
 */

import type { GuardRailPolicies } from "./types";

/**
 * SSRF / 内网地址 pattern —— **单一来源**。
 *
 * 抽出来的目的：同一条规则要被两处复用且不能漂移：
 *   1. L2 工具参数黑名单（拦 web_search 的 SSRF query）
 *   2. generalQANodeStream 输入侧短路（用户直接喊"上网查 localhost"时，
 *      在跑完整 pipeline 前就短路拒答，避免 webResult=null 留下 prompt 真空
 *      → 模型扫历史串话。2026-05-19 服务器实测复现的串话回归修复点）
 * 改一处两边全生效；context-bleed 回归测的就是这条线上真规则。
 */
export const SSRF_INTERNAL_PATTERN =
  /(file:\/\/|gopher:\/\/|jar:|dict:\/\/|169\.254\.169\.254|metadata\.google\.internal|127\.0\.0\.1[:\/]|localhost[:\/]|192\.168\.\d|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d)/i;

export const DEFAULT_POLICIES: GuardRailPolicies = {
  // ============ L1 注入检测规则 ============
  injectionRules: [
    // 经典 prompt injection（允许中间有"所有"/"全部"/"的"等连接词）
    {
      id: "inj-ignore-prev",
      pattern: /(忽略|忽视|无视|清空)[\s\S]{0,5}?(以上|之前|以前|前面|上面)[\s\S]{0,8}?(指令|提示|内容|规则|prompt)/i,
      risk: "high",
      reason: "尝试覆盖系统指令（中文）",
    },
    {
      id: "inj-ignore-en",
      pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
      risk: "high",
      reason: "Classic English prompt injection",
    },
    {
      id: "inj-jailbreak-dan",
      pattern: /\b(DAN|do anything now|developer mode|jailbreak)\b/i,
      risk: "high",
      reason: "已知越狱模板（DAN / Developer Mode / Jailbreak）",
    },
    {
      id: "inj-roleplay-system",
      pattern: /(你现在是|你扮演|从现在开始你是|act as|you are now)\s*[（(]?\s*(管理员|admin|root|系统|sudoer|无限制|开发者|超级用户)/i,
      risk: "high",
      reason: "试图通过角色扮演绕过限制",
    },
    {
      id: "inj-pseudo-role",
      // 行首伪造角色头 + 冒号（中英文冒号）+ 任意载荷。
      // 原版强制冒号后必须跟空白，漏掉了"assistant：好的"这类中文无空格写法
      pattern: /(^|\n)\s*(system|assistant|user)\s*[:：]\s*\S/i,
      risk: "medium",
      reason: "伪造 system / assistant / user 角色头",
    },
    {
      id: "inj-prompt-leak",
      // 覆盖中英文：system prompt / system instruction(s) / 系统提示 / 系统指令 / 原始指令
      pattern: /(打印|输出|告诉我|reveal|show me|print|输出原始)(.*?)(system\s*(prompt|instructions?)|系统(提示|指令)|原始指令)/i,
      risk: "high",
      reason: "尝试泄露 system prompt",
    },
    {
      id: "inj-secret-leak",
      pattern: /(api[\s_-]?key|access[\s_-]?token|secret|密钥|access\s*key|admin\s*password|管理员密码)/i,
      risk: "medium",
      reason: "试图套取密钥 / Token / 管理员密码",
    },
    // markdown 注入（用代码块包裹假指令）
    {
      id: "inj-markdown-fence",
      pattern: /```\s*(system|assistant)[:\s]/i,
      risk: "medium",
      reason: "Markdown 代码块伪装的注入",
    },
  ],
  maxInputLength: 4000,

  // ============ L2 工具参数黑名单 ============
  toolBlacklist: [
    // SQL 注入特征
    { pattern: /\b(union\s+select|drop\s+table|or\s+1\s*=\s*1|--\s*$)/i, reason: "疑似 SQL 注入" },
    // Shell 注入
    { pattern: /(\$\{IFS\}|`.*?`|;\s*(rm|cat|curl|wget|sh)\s)/i, reason: "疑似 Shell 注入" },
    // SSRF：常见内网/特殊协议地址（云元数据 / localhost / 私网段 / file:// 等）
    // pattern 复用顶部 SSRF_INTERNAL_PATTERN 单一来源（输入短路也用同一条）
    { pattern: SSRF_INTERNAL_PATTERN, reason: "疑似 SSRF / 内网访问" },
  ],
  maxToolQueryLength: 500,

  // ============ L3 输出验证 ============
  // relevanceThreshold：现为 **embedding 余弦** 阈值（DashScope text-embedding-v2）。
  //   经验上中文"问题↔相关答案"余弦多在 0.4~0.7，明显跑题 < 0.3。取 0.30 作为
  //   保守下限：仅对"明显离题"报 ⚠️。L3 永远 allow（只观测、不拦截），阈值偏差
  //   只影响一个咨询性 ⚠️、不改变行为，故无需过度精调。
  //   （旧值 0.25 是 Jaccard 词面时代的，对 embedding 余弦无意义，已重标定。）
  relevanceThreshold: 0.30,
  // factVerificationRatio：事实覆盖率门槛。注意此项当前仍是**词面 token 覆盖**
  //   （非语义），偏宽松取 0.3；升级为 embedding/NLI 语义核验是已记录的路线图项。
  factVerificationRatio: 0.3,
};
