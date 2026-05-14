/**
 * 页面访问埋点接收端
 *
 * 前端 <PageviewTracker> 在路由变化时用 navigator.sendBeacon 打一条到这里。
 * 这里补上只有服务端知道的 UA、判定爬虫，然后 fire-and-forget 写库（照搬
 * event-logger 的静默容错：绝不阻塞、绝不抛、表缺失也不报错）。
 *
 * 诚实边界：
 * - visitorId 是浏览器 localStorage 号码牌，区分的是「浏览器」而非「肉身」。
 * - 不记录原始 IP（按需求）；当前部署 Next 直跑 3000 无 nginx 也拿不到真实 IP。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPageViewRepository } from "@tech-mate/database";
import { getDatabase } from "@/lib/database";

const DEFAULT_USER_ID = "default-user";

// 常见爬虫 / 自动化 UA 特征，命中则标 isBot（看板默认过滤）
const BOT_UA =
  /bot|spider|crawl|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|headless|phantomjs|python-requests|curl\/|wget|axios\/|go-http|java\/|okhttp|scrapy|baiduspider|yandex|sogou|bytespider|semrush|ahrefs|mj12|dotbot/i;

export async function POST(request: NextRequest) {
  // 任何异常都吞掉，返回 204，绝不影响访客体验
  try {
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // sendBeacon 偶发非标准 content-type，兜底按文本解析
      const text = await request.text().catch(() => "");
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
    }

    const visitorId = String(body.visitorId || "").slice(0, 64).trim();
    const path = String(body.path || "").slice(0, 512).trim();

    // 没有号码牌或路径，无意义，直接丢弃
    if (!visitorId || !path) {
      return new NextResponse(null, { status: 204 });
    }

    // 不统计管理员自己看访问看板（避免自己刷自己）
    if (path.startsWith("/dashboard/visits")) {
      return new NextResponse(null, { status: 204 });
    }

    const referrer = body.referrer ? String(body.referrer).slice(0, 512) : null;
    const userId = body.userId ? String(body.userId).slice(0, 64) : DEFAULT_USER_ID;
    const userAgent = request.headers.get("user-agent")?.slice(0, 512) || null;
    const isBot = userAgent ? BOT_UA.test(userAgent) : false;

    // fire-and-forget：不 await 写库结果，立刻返回
    void (async () => {
      try {
        await getDatabase();
        await getPageViewRepository().record({
          visitorId,
          userId,
          path,
          referrer,
          userAgent,
          isBot,
        });
      } catch {
        /* 表未 migrate / DB 不可用都静默，不影响访客 */
      }
    })();

    return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
