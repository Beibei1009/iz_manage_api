import { NextResponse } from "next/server";
import { isAuthed, requireUser } from "../../../lib/gate";
import { getTelegramSettings, saveTelegramSettings } from "../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/settings — cấu hình Telegram. Chưa đăng nhập: KHÔNG trả token (chỉ báo đã đặt
// hay chưa) — token là bí mật, không cho người lạ đọc.
export async function GET(req) {
  const s = await getTelegramSettings();
  if (!isAuthed(req)) {
    return NextResponse.json(
      { telegram: { bot_token: "", bot_token_set: !!s.bot_token, chat_id: "", enabled: s.enabled } },
      { headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(
    { telegram: { bot_token: s.bot_token, bot_token_set: !!s.bot_token, chat_id: s.chat_id, enabled: s.enabled } },
    { headers: { "cache-control": "no-store" } });
}

// POST /api/settings — lưu cấu hình Telegram (cần đăng nhập).
export async function POST(req) {
  const guard = requireUser(req);
  if (guard) return guard;
  const b = await req.json().catch(() => ({}));
  const s = await saveTelegramSettings({
    bot_token: b.bot_token, chat_id: b.chat_id, enabled: b.enabled });
  return NextResponse.json({
    ok: true,
    telegram: { bot_token: s.bot_token, bot_token_set: !!s.bot_token, chat_id: s.chat_id, enabled: s.enabled },
  });
}
