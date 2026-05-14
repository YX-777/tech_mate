/**
 * 检索使用决策 —— **纯函数单一来源**（可确定性单测，nodes.ts 直接用）
 *
 * 2026-05 修复点：旧代码用 `ragResults.length>0 ? "candidates" : undefined` 捏假
 * tier，把真实低置信信号（expand/fallback）丢了 → 17% 垃圾当参考来源、且本地
 * miss 也不联网兜底。这里把"KB 算不算可信命中""要不要联网"抽成纯逻辑：
 *
 *  - precise(≥0.85)/candidates(≥0.6)：算可信命中，KB 可作依据展示
 *  - expand(<0.6 有结果)/fallback(0 结果)：低/无置信，不当依据
 *  - 联网：expand/fallback → 兜底（覆盖模型先前 useWeb=false，A 治本）；
 *          candidates → 也联网做 KB+web 双源交叉核对（B1）；
 *          precise → 不自动联网（除非模型/时效关键词另外要）
 */

export type KbTier = "precise" | "candidates" | "expand" | "fallback" | "";

/** KB 是否算"可信命中"——只有 precise/candidates 且确有结果 */
export function isKbConfident(tier: string, resultCount: number): boolean {
  return resultCount > 0 && (tier === "precise" || tier === "candidates");
}

/** 该 tier 是否需要联网（expand/fallback 兜底 + candidates 多源） */
export function tierWantsWeb(tier: string): boolean {
  return tier === "expand" || tier === "fallback" || tier === "candidates";
}

/**
 * 是否发起联网搜索。
 * - 任务查询（答案在本地 SQLite）→ 永不联网
 * - 模型显式要 / 解析失败回退的关键词启发式命中 / tier 需要 → 联网
 */
export function decideWeb(opts: {
  isTaskQuery: boolean;
  modelUseWeb: boolean;
  planFellBack: boolean;
  heuristicWeb: boolean;
  tier: string;
}): boolean {
  if (opts.isTaskQuery) return false;
  return (
    opts.modelUseWeb ||
    (opts.planFellBack && opts.heuristicWeb) ||
    tierWantsWeb(opts.tier)
  );
}
