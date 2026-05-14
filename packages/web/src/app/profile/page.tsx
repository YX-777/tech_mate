/**
 * 个人记忆档案 - 入口（SSR）
 *
 * 用户私有数据 + 首屏即核心内容 → 选 SSR：
 *  - Server Component 并行预取 profile + memories，注水给 Client Component
 *  - 首屏直出昵称 + 长期记忆列表，无 loading 闪屏
 *  - dynamic = 'force-dynamic' 强制每次请求重新渲染（编辑后立即可见）
 */

import ProfilePageClient from "./ProfilePageClient";
import type { UserProfile, LongTermMemoryItem } from "@/types";

export const dynamic = "force-dynamic";

const DEFAULT_USER_ID = "default-user";

async function fetchInitial(): Promise<{
  profile: UserProfile | null;
  memories: LongTermMemoryItem[] | null;
}> {
  const base = process.env.NEXT_INTERNAL_API_URL || "http://localhost:3000";
  const [profileRes, memoriesRes] = await Promise.allSettled([
    fetch(`${base}/api/profile?userId=${DEFAULT_USER_ID}`, { cache: "no-store" }),
    fetch(`${base}/api/memory/long-term?userId=${DEFAULT_USER_ID}`, { cache: "no-store" }),
  ]);

  let profile: UserProfile | null = null;
  if (profileRes.status === "fulfilled" && profileRes.value.ok) {
    try {
      const data = await profileRes.value.json();
      profile = data.profile
        ? {
            nickname: data.profile.nickname || "学习者",
            totalStudyDays: data.profile.totalStudyDays || 0,
          }
        : null;
    } catch {}
  }

  let memories: LongTermMemoryItem[] | null = null;
  if (memoriesRes.status === "fulfilled" && memoriesRes.value.ok) {
    try {
      const data = await memoriesRes.value.json();
      memories = Array.isArray(data.memories) ? data.memories : null;
    } catch {}
  }

  return { profile, memories };
}

export default async function ProfilePage() {
  const { profile, memories } = await fetchInitial();
  return <ProfilePageClient initialProfile={profile} initialMemories={memories} />;
}
