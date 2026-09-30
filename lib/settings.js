// Cài đặt chung của hệ (hiện chỉ có Telegram) — lưu trong collection `settings`,
// doc _id="telegram". Dùng chung cho web + cron notify.
import { getDb } from "./mongo";

export async function getTelegramSettings() {
  const db = await getDb();
  const doc = await db.collection("settings").findOne({ _id: "telegram" });
  return {
    bot_token: doc?.bot_token || "",
    chat_id: doc?.chat_id || "",
    enabled: doc?.enabled !== false, // mặc định bật
  };
}

export async function saveTelegramSettings({ bot_token, chat_id, enabled }) {
  const db = await getDb();
  const set = { updated_at: new Date() };
  if (bot_token !== undefined) set.bot_token = String(bot_token || "").trim();
  if (chat_id !== undefined) set.chat_id = String(chat_id || "").trim();
  if (enabled !== undefined) set.enabled = !!enabled;
  await db.collection("settings").updateOne(
    { _id: "telegram" }, { $set: set }, { upsert: true });
  return getTelegramSettings();
}
