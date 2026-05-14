/**
 * 访问统计看板 API（仅管理员，受 middleware 密码门保护）
 *
 * 聚合 page_views：
 *  - overview: 总 PV / 独立访客 UV / 时间范围
 *  - topPaths: 最热页面
 *  - visitors: 按 visitorId 分组（访问次数 / 末次时间 / 解析后的浏览器·系统 / 首个来源）
 *  - recent: 最近访问明细
 *
 * 默认过滤爬虫；?includeBots=1 可纳入。聚合基于最近 1000 条（demo 量级足够）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPageViewRepository } from "@tech-mate/database";
import { getDatabase } from "@/lib/database";

/** 轻量 UA 解析：够看板区分「不同的人/设备」即可，不引重型依赖 */
function parseUA(ua: string | null): { browser: string; os: string } {
  if (!ua) return { browser: "未知", os: "未知" };
  let browser = "其他";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = "Safari";
  else if (/MicroMessenger/i.test(ua)) browser = "微信";

  let os = "其他";
  if (/Windows NT/.test(ua)) os = "Windows";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Linux/.test(ua)) os = "Linux";

  return { browser, os };
}

export async function GET(request: NextRequest) {
  try {
    await getDatabase();
    const includeBots = request.nextUrl.searchParams.get("includeBots") === "1";

    const repo = getPageViewRepository();

    // 表未 migrate 时静默兜底为空
    const [totalPV, uniqueVisitors, rows] = await Promise.all([
      repo.countAll(includeBots).catch(() => 0),
      repo.countUniqueVisitors(includeBots).catch(() => 0),
      repo.recent(1000, includeBots).catch(() => [] as any[]),
    ]);

    // —— 按页面聚合 ——
    const pathMap = new Map<string, number>();
    // —— 按访客聚合 ——
    const visitorMap = new Map<
      string,
      { visitorId: string; count: number; lastSeen: string; firstSeen: string; ua: string | null; firstReferrer: string | null }
    >();

    for (const r of rows as any[]) {
      const path = r.path || "/";
      pathMap.set(path, (pathMap.get(path) || 0) + 1);

      const createdAt = r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt);
      const existing = visitorMap.get(r.visitorId);
      if (!existing) {
        visitorMap.set(r.visitorId, {
          visitorId: r.visitorId,
          count: 1,
          lastSeen: createdAt,
          firstSeen: createdAt,
          ua: r.userAgent || null,
          firstReferrer: r.referrer || null,
        });
      } else {
        existing.count++;
        // rows 按 createdAt desc，故先遇到的是更晚的 → 后遇到的更早，更新 firstSeen
        existing.firstSeen = createdAt;
        if (!existing.firstReferrer && r.referrer) existing.firstReferrer = r.referrer;
      }
    }

    const topPaths = Array.from(pathMap.entries())
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const visitors = Array.from(visitorMap.values())
      .map((v) => {
        const { browser, os } = parseUA(v.ua);
        return {
          visitorId: v.visitorId,
          short: v.visitorId.slice(0, 8),
          count: v.count,
          browser,
          os,
          lastSeen: v.lastSeen,
          firstSeen: v.firstSeen,
          referrer: v.firstReferrer,
        };
      })
      .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());

    const recent = (rows as any[]).slice(0, 50).map((r) => {
      const { browser, os } = parseUA(r.userAgent || null);
      return {
        id: r.id,
        visitorShort: String(r.visitorId).slice(0, 8),
        path: r.path,
        referrer: r.referrer || null,
        browser,
        os,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      };
    });

    return NextResponse.json({
      success: true,
      overview: {
        totalPV,
        uniqueVisitors,
        sampleSize: rows.length,
        includeBots,
      },
      topPaths,
      visitors,
      recent,
    });
  } catch (error) {
    console.error("Failed to fetch visits dashboard:", error);
    return NextResponse.json({ error: "Failed to fetch visits" }, { status: 500 });
  }
}
