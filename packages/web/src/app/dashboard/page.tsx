/**
 * Agent 系统看板 - 入口（CSR）
 *
 * 监控场景实时性优先 —— 数据每次访问从 /api/dashboard/agent 实时拉取，
 * 配合页面内"刷新"按钮支持手动刷新。
 *
 * 评估过 ISR：聚合查询慢确实有"缓存首屏"价值，但 1 小时 stale cache 在
 * "刚发的请求要立刻看到事件流水里"的演示场景下会翻车，所以最终选 CSR。
 */

import AgentDashboardClient from "./AgentDashboardClient";

export default function DashboardPage() {
  return <AgentDashboardClient />;
}
