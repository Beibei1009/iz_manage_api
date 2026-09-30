// Auth NGƯỜI DÙNG cho BE — thay cho lib/auth.js (cookie) bên FE.
// FE proxy đã xác thực cookie rồi báo sang qua header `x-izp-authed: 1|0`; BE chỉ đọc cờ đó.
// (Việc BE tin cờ này là AN TOÀN vì mọi request tới BE đã phải có `x-izp-key` = API_SECRET,
//  kiểm ở middleware.js — chỉ FE proxy / tool nội bộ mới có key.)
import { NextResponse } from "next/server";

export function isAuthed(req) {
  return req.headers.get("x-izp-authed") === "1";
}

/** Cổng cho route ĐỔI DỮ LIỆU cần đăng nhập. Trả 401 nếu chưa; null nếu cho qua. */
export function requireUser(req) {
  return isAuthed(req) ? null : NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
}
