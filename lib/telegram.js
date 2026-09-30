// Gửi tin nhắn qua Telegram Bot API. KHÔNG bao giờ throw — trả {ok,error} để chỗ gọi
// (cron) log được mà không vỡ luồng. Bê từ HealthCheck (src/lib/telegram.ts).

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendTelegramMessage({ botToken, chatId }, text) {
  if (!botToken || !chatId) return { ok: false, error: "Thiếu bot token hoặc chat id" };
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Telegram API ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || "Không gọi được Telegram" };
  } finally {
    clearTimeout(timeout);
  }
}
