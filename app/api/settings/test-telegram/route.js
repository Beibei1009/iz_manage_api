import { NextResponse } from "next/server";
import { requireUser } from "../../../../lib/gate";
import { getTelegramSettings } from "../../../../lib/settings";
import { sendTelegramMessage } from "../../../../lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/settings/test-telegram — gửi 1 tin test. Ưu tiên giá trị đang gõ trên form
// (để test TRƯỚC khi lưu); thiếu thì lấy từ DB.
export async function POST(req) {
  const guard = requireUser(req);
  if (guard) return guard;
  const b = await req.json().catch(() => ({}));
  let botToken = (b.bot_token || "").trim();
  let chatId = (b.chat_id || "").trim();
  if (!botToken || !chatId) {
    const s = await getTelegramSettings();
    botToken = botToken || s.bot_token;
    chatId = chatId || s.chat_id;
  }
  const r = await sendTelegramMessage(
    { botToken, chatId },
    "✅ <b>IzPipeline</b> — test thông báo Telegram OK.\nBot đã gửi được vào group này.");
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
