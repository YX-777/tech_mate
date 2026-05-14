/**
 * 学习任务管理 - 入口（SSR）
 *
 * 用户私有数据 + 首屏即核心内容 → 选 SSR：
 *  - Server Component 在请求期内预取任务列表，注水给 Client Component
 *  - 首屏直出数据，无 loading 闪屏
 *  - dynamic = 'force-dynamic' 强制每次请求重新渲染（数据写后立即可见，不缓存）
 *
 * 构建期不会调本地 API（force-dynamic 直接跳过 prerender），任何环境构建都安全。
 */

import TasksPageClient from "./TasksPageClient";
import type { Task } from "@/types";

// SSR：force-dynamic 让 Next 不在构建期 prerender 这个页面
export const dynamic = "force-dynamic";

const DEFAULT_USER_ID = "default-user";

async function fetchInitialTasks(): Promise<Task[] | null> {
  try {
    // 服务器进程内回环（始终是 localhost:3000，不走外网反代）
    const base = process.env.NEXT_INTERNAL_API_URL || "http://localhost:3000";
    const res = await fetch(`${base}/api/tasks?userId=${DEFAULT_USER_ID}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.tasks) ? data.tasks : null;
  } catch {
    // API 暂不可用 → null，Client Component 自动 fallback 到 CSR fetch
    return null;
  }
}

export default async function TasksPage() {
  const initialTasks = await fetchInitialTasks();
  return <TasksPageClient initialTasks={initialTasks} />;
}
