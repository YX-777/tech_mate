/**
 * 管理员口令登录（访问看板的密码门）
 *
 * 校验 body.key === 环境变量 ADMIN_KEY，通过则种 httpOnly cookie `tm_admin`，
 * 之后 middleware 凭此放行 /dashboard/visits。无需用户系统。
 */
import { NextRequest, NextResponse } from "next/server";

const COOKIE = "tm_admin";

export async function POST(req: NextRequest) {
  const key = process.env.ADMIN_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "服务端未配置 ADMIN_KEY，请在 packages/web/.env 设置后重启服务" },
      { status: 500 }
    );
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }

  if (String(body.key || "") !== key) {
    return NextResponse.json({ error: "口令错误" }, { status: 401 });
  }

  const res = NextResponse.json({ success: true });
  res.cookies.set(COOKIE, key, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 天
  });
  return res;
}
