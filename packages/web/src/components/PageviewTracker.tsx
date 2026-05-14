"use client";

/**
 * 页面访问埋点（客户端，无 UI，访客无感）
 *
 * 原理：
 * 1. 首访时给浏览器发一张「号码牌」visitorId（随机 UUID 存 localStorage），
 *    之后每次访问都带着它 —— 无登录也能区分「是不是同一个浏览器/人」。
 * 2. 路由变化时（App Router 客户端跳转不刷整页，必须前端打点）用
 *    navigator.sendBeacon 把 {visitorId, path, referrer, userId} 发给 /api/track。
 *    sendBeacon 专为埋点设计：页面关闭也能可靠发出、不阻塞跳转、失败静默。
 * 3. useRef 去重，避免 StrictMode / 重复渲染把同一路径打两次。
 *
 * 挂在根 layout，全站生效。任何异常都不影响页面。
 */
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const VISITOR_KEY = "tm_vid";
const DEFAULT_USER_ID = "default-user";

function getVisitorId(): string {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    // localStorage 不可用（隐私模式等）→ 退化为一次性会话 id，不报错
    return `nostore_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export default function PageviewTracker() {
  const pathname = usePathname();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname) return;
    // 去重：同一路径不重复打点
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;

    // 不统计管理员看访问看板本身
    if (pathname.startsWith("/dashboard/visits")) return;

    try {
      const payload = JSON.stringify({
        visitorId: getVisitorId(),
        path: pathname,
        referrer: document.referrer || null,
        userId: DEFAULT_USER_ID,
      });
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/track", blob);
      } else {
        // 极老浏览器兜底
        fetch("/api/track", { method: "POST", body: payload, keepalive: true }).catch(() => {});
      }
    } catch {
      /* 埋点失败绝不影响页面 */
    }
  }, [pathname]);

  return null;
}
