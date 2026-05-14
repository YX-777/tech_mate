import { NextRequest, NextResponse } from "next/server";

/**
 * 访问统计看板的「单口令密码门」（无需登录系统）
 *
 * 只保护 /dashboard/visits（访问记录，仅你可见）和它的 API；
 * 现有的 Agent 看板 / Trace Viewer 是面试展示用的，保持公开、不在此拦截。
 *
 * 逻辑：cookie `tm_admin` === 环境变量 ADMIN_KEY 才放行；否则页面跳登录、API 返 401。
 * cookie 由 /api/admin-login 在校验口令后种下（httpOnly）。
 *
 * 想把整个 /dashboard 都关进门：把 matcher 改成 ["/dashboard/:path*", "/api/dashboard/:path*"]，
 * 并把下面登录页放行判断同步即可。
 */
const COOKIE = "tm_admin";
const LOGIN_PATH = "/dashboard/visits/login";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 登录页放行，避免自我拦截死循环
  if (pathname.startsWith(LOGIN_PATH)) return NextResponse.next();

  const key = process.env.ADMIN_KEY;
  const cookie = req.cookies.get(COOKIE)?.value;
  const authed = !!key && cookie === key;
  if (authed) return NextResponse.next();

  // 未授权：API 返 401，页面跳登录
  if (pathname.startsWith("/api/dashboard/visits")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/visits", "/dashboard/visits/:path*", "/api/dashboard/visits/:path*"],
};
