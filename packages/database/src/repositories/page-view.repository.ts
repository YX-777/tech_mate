import type { PageView } from "@prisma/client";
import { BaseRepository } from "./base.repository";

/**
 * 页面访问埋点仓储
 *
 * 无登录场景下用 visitorId（浏览器 localStorage 号码牌）区分访客；
 * 只存 UA、不存原始 IP；isBot 标记爬虫，聚合时默认过滤。
 * 写入走 fire-and-forget（见 /api/track），查询给看板用。
 */
export class PageViewRepository extends BaseRepository<PageView> {
  constructor(prisma: any) {
    super(prisma, "pageView");
  }

  /** 记录一次访问 */
  async record(data: {
    visitorId: string;
    userId?: string | null;
    path: string;
    referrer?: string | null;
    userAgent?: string | null;
    isBot?: boolean;
  }): Promise<PageView> {
    return this.prisma.pageView.create({
      data: {
        visitorId: data.visitorId,
        userId: data.userId ?? null,
        path: data.path,
        referrer: data.referrer ?? null,
        userAgent: data.userAgent ?? null,
        isBot: data.isBot ?? false,
      },
    });
  }

  /** 总 PV（默认排除爬虫） */
  async countAll(includeBots = false): Promise<number> {
    return this.prisma.pageView.count({
      where: includeBots ? {} : { isBot: false },
    });
  }

  /** 独立访客数 UV（按 visitorId 去重，默认排除爬虫） */
  async countUniqueVisitors(includeBots = false): Promise<number> {
    const rows = await this.prisma.pageView.groupBy({
      by: ["visitorId"],
      where: includeBots ? {} : { isBot: false },
    });
    return rows.length;
  }

  /** 最近 N 条访问明细（默认排除爬虫，看板按需可含） */
  async recent(limit = 1000, includeBots = false): Promise<PageView[]> {
    return this.prisma.pageView.findMany({
      where: includeBots ? {} : { isBot: false },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}
