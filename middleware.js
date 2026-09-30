// Cổng chung: MỌI /api/* phải mang header `x-izp-key` = API_SECRET (chỉ FE proxy + tool nội bộ
// biết) — trừ /api/health (ping sống). Đây là ranh giới tin cậy để BE dám tin `x-izp-authed`.
import { NextResponse } from "next/server";

export const config = { matcher: ["/api/:path*"] };

export function middleware(req) {
  if (req.nextUrl.pathname === "/api/health") return NextResponse.next();
  const key = req.headers.get("x-izp-key");
  const secret = process.env.API_SECRET;
  if (!secret || key !== secret) {
    return NextResponse.json({ error: "forbidden (x-izp-key)" }, { status: 401 });
  }
  return NextResponse.next();
}
