import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/mongo";
import { getTelegramSettings } from "../../../../lib/settings";
import { sendTelegramMessage, escapeHtml } from "../../../../lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Trạng thái tts. Khớp iz_pipeline status.py.
const RUNNING = "tts_running";
const WAITING = "waiting_human_tts";
const INCOMING = ["uploaded_to_drive", "claimed_by_vps", "vps_downloading", "vps_received"];
const INFLIGHT = [RUNNING, WAITING, ...INCOMING, "tts_done", "audio_packing", "audio_uploading"];

// Nhắc "còn nhiều srt chờ bấm": ngưỡng số task + giãn cách nhắc lại (tránh spam mỗi phút).
const WAIT_REMIND_MIN = 3;
const WAIT_REMIND_COOLDOWN_MS = 30 * 60 * 1000;

// Cron heartbeat (Cloudflare Worker gọi mỗi phút). Mỗi task báo ĐÚNG 1 LẦN/loại nhờ cờ
// notify.* claim nguyên tử; gửi lỗi thì nhả cờ để phút sau gửi lại.
async function handle(req) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const q = req.nextUrl.searchParams.get("secret");
    if (bearer !== secret && q !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const tg = await getTelegramSettings();
  if (!tg.enabled || !tg.bot_token || !tg.chat_id) {
    return NextResponse.json({ ok: true, skipped: "telegram chưa cấu hình / đang tắt" });
  }
  const send = (text) => sendTelegramMessage({ botToken: tg.bot_token, chatId: tg.chat_id }, text);

  // Thử nối lại 1 lần: container lạnh gặp Atlas M0 chậm hay trượt lần đầu; getDb()
  // đã xoá cache khi reject nên lần 2 tạo client mới thật sự.
  let db;
  try { db = await getDb(); }
  catch (e) { console.error('[notify-tts] nối Mongo lỗi, thử lại:', e?.message);
              db = await getDb(); }
  const jobs = db.collection("jobs");
  const machines = db.collection("machines");
  const settings = db.collection("settings");

  const nameCache = {};
  async function machineName(id) {
    if (!id) return "?";
    if (nameCache[id] !== undefined) return nameCache[id];
    const m = await machines.findOne({ _id: id }, { projection: { name: 1 } });
    return (nameCache[id] = m?.name || id);
  }
  async function vpsLoad(vpsId) {
    if (!vpsId) return { running: 0, waiting: 0, incoming: 0 };
    const base = { tts_target: vpsId, "control.desired": "run" };
    const [running, waiting, incoming] = await Promise.all([
      jobs.countDocuments({ ...base, "stages.tts.status": RUNNING }),
      jobs.countDocuments({ ...base, "stages.tts.status": WAITING }),
      jobs.countDocuments({ ...base, "stages.tts.status": { $in: INCOMING } }),
    ]);
    return { running, waiting, incoming };
  }
  const vpsOf = (c) => c.tts_target || c.devices?.vps || "";
  const localOf = (c) => c.owner_machine || c.devices?.pipeline || "";

  const counts = {};
  const bump = (k, n = 1) => (counts[k] = (counts[k] || 0) + n);
  const errors = {};
  // Mỗi mục chạy ĐỘC LẬP: 1 mục hỏng (Atlas chập, Telegram 429…) không được phép nuốt
  // luôn các mục sau — trước đây cả route ném lỗi → 500 → mục (4) publish không bao giờ
  // chạy dù (1)(2)(3) đã gửi xong.
  async function step(name, fn) {
    try { await fn(); }
    catch (e) { errors[name] = String(e?.message || e).slice(0, 300);
                console.error(`[notify-tts] mục ${name} lỗi:`, e); }
  }

  // Gom theo VPS: claim từng task, gửi 1 tin/VPS liệt kê task. Dùng cho case "vào hàng chờ"
  // và "đã bấm MiniMax".
  async function groupByVps({ status, flag, render }) {
    const cands = await jobs.find({
      "stages.tts.status": status, "control.desired": { $ne: "deleted" },
      [`notify.${flag}`]: { $ne: true },
    }, { projection: { tts_target: 1, devices: 1 } }).limit(60).toArray();
    const byVps = {};
    for (const c of cands) {
      const claim = await jobs.findOneAndUpdate(
        { _id: c._id, "stages.tts.status": status, [`notify.${flag}`]: { $ne: true } },
        { $set: { [`notify.${flag}`]: true, [`notify.${flag}_at`]: new Date() } });
      if (!claim) continue;
      (byVps[vpsOf(c)] ||= []).push(c._id);
    }
    for (const [vpsId, ids] of Object.entries(byVps)) {
      const [vpsName, load] = await Promise.all([machineName(vpsId), vpsLoad(vpsId)]);
      const r = await send(render(vpsName, ids, load));
      if (r.ok) bump(flag, ids.length);
      else await jobs.updateMany({ _id: { $in: ids } },
        { $unset: { [`notify.${flag}`]: "", [`notify.${flag}_at`]: "" } });
    }
  }

  // ── (1) 📥 Vào hàng chờ TTS (srt đã ở ready/, chờ NGƯỜI bấm) ──
  await step("tts_queued", () => groupByVps({
    status: WAITING, flag: "tts_queued_sent",
    render: (vps, ids, load) =>
      `📥 <b>Vào hàng chờ TTS</b> — VPS <b>${escapeHtml(vps)}</b>\n` +
      `📋 Task: ${ids.map(escapeHtml).join(", ")}\n` +
      `👉 Vào bấm chạy MiniMax · 🎧 chờ bấm ${load.waiting} · đang chạy ${load.running}`,
  }));

  // ── (2) ▶️ Đã bấm chạy MiniMax ──
  await step("tts_started", () => groupByVps({
    status: RUNNING, flag: "tts_started_sent",
    render: (vps, ids, load) =>
      `▶️ <b>Đã bấm chạy MiniMax</b> — VPS <b>${escapeHtml(vps)}</b>\n` +
      `📋 Task: ${ids.map(escapeHtml).join(", ")}\n` +
      `🎧 đang chạy ${load.running} · chờ bấm ${load.waiting} · đang về ${load.incoming}`,
  }));

  // ── (3) ✅ TTS xong (audio đã về máy local) — mỗi task 1 tin ──
  await step("tts_done", async () => {
    const done = await jobs.find({
      "stages.tts.status": "audio_ready", "control.desired": { $ne: "deleted" },
      "notify.tts_done_sent": { $ne: true },
    }, { projection: { owner_machine: 1, tts_target: 1, devices: 1, "stages.capcut.status": 1 } })
      .limit(30).toArray();
    const totalInflight = await jobs.countDocuments({
      "control.desired": "run", "stages.tts.status": { $in: INFLIGHT } });
    for (const c of done) {
      const claim = await jobs.findOneAndUpdate(
        { _id: c._id, "stages.tts.status": "audio_ready", "notify.tts_done_sent": { $ne: true } },
        { $set: { "notify.tts_done_sent": true, "notify.tts_done_at": new Date() } });
      if (!claim) continue;
      const [localName, vpsName, load] = await Promise.all([
        machineName(localOf(c)), machineName(vpsOf(c)), vpsLoad(vpsOf(c))]);
      const capReady = c.stages?.capcut?.status === "ready";
      const text =
        `✅ <b>Task [${escapeHtml(c._id)}]</b> — TTS XONG\n` +
        `🖥 Audio về máy: <b>${escapeHtml(localName)}</b> → ` +
        (capReady ? "CapCut được rồi!" : "đang chờ cắt clip xong") + "\n" +
        `🎧 VPS <b>${escapeHtml(vpsName)}</b>: chạy ${load.running} · chờ bấm ${load.waiting} · đang về ${load.incoming}\n` +
        `📊 Hàng TTS còn lại: ${totalInflight} task`;
      const r = await send(text);
      if (r.ok) bump("tts_done_sent");
      else await jobs.updateOne({ _id: c._id },
        { $unset: { "notify.tts_done_sent": "", "notify.tts_done_at": "" } });
    }
  });

  // ── (4) 🎬 Publish xong (đã đăng, có link) — mỗi task 1 tin, kèm MÁY đã push ──
  await step("publish", async () => {
    const pub = await jobs.find({
      "stages.publish.status": "link_ready", "control.desired": { $ne: "deleted" },
      "notify.publish_sent": { $ne: true },
    }, { projection: { owner_machine: 1, devices: 1, "final.video_link": 1 } }).limit(30).toArray();
    for (const c of pub) {
      const claim = await jobs.findOneAndUpdate(
        { _id: c._id, "stages.publish.status": "link_ready", "notify.publish_sent": { $ne: true } },
        { $set: { "notify.publish_sent": true, "notify.publish_at": new Date() } });
      if (!claim) continue;
      const localName = await machineName(localOf(c));
      const link = c.final?.video_link || "(chưa có link)";
      const text =
        `🎬 <b>Task [${escapeHtml(c._id)}]</b> — ĐÃ ĐĂNG XONG\n` +
        `🖥 Máy push: <b>${escapeHtml(localName)}</b>\n` +
        `🔗 ${escapeHtml(link)}`;
      const r = await send(text);
      if (r.ok) bump("publish_sent");
      else await jobs.updateOne({ _id: c._id },
        { $unset: { "notify.publish_sent": "", "notify.publish_at": "" } });
    }
  });

  // ── (5) 📣 Nhắc VPS còn nhiều srt CHỜ BẤM (throttle 30', CLAIM NGUYÊN TỬ chống trùng) ──
  await step("wait_reminder", async () => {
    const waitAgg = await jobs.aggregate([
      { $match: { "stages.tts.status": WAITING, "control.desired": "run" } },
      { $group: { _id: "$tts_target", n: { $sum: 1 } } },
    ]).toArray();
    // đảm bảo doc tồn tại để findOneAndUpdate (claim) hoạt động lần đầu
    await settings.updateOne({ _id: "notify_state" },
      { $setOnInsert: { _created: new Date() } }, { upsert: true });
    const cutoff = new Date(Date.now() - WAIT_REMIND_COOLDOWN_MS);
    for (const g of waitAgg) {
      const vpsId = g._id;
      if (!vpsId || g.n < WAIT_REMIND_MIN) continue;
      const key = String(vpsId).replace(/[.$]/g, "_");
      // CLAIM: chỉ 1 lời gọi giành được ô nhắc (field vắng hoặc cũ hơn cutoff) → set 'now'.
      // Lời gọi song song thấy field = now (> cutoff) → không khớp → không gửi trùng.
      const claim = await settings.findOneAndUpdate(
        { _id: "notify_state",
          $or: [{ [`wait_reminder.${key}`]: { $exists: false } },
                { [`wait_reminder.${key}`]: { $lte: cutoff } }] },
        { $set: { [`wait_reminder.${key}`]: new Date() } });
      if (!claim) continue;   // không giành được (đã có máy khác nhắc trong 30' qua)
      const [vpsName, load] = await Promise.all([machineName(vpsId), vpsLoad(vpsId)]);
      const r = await send(
        `📣 <b>Nhắc:</b> VPS <b>${escapeHtml(vpsName)}</b> còn <b>${g.n}</b> srt CHỜ BẤM MiniMax\n` +
        `👉 Vào listener bấm chạy để không nghẽn · 🎧 đang chạy ${load.running} · đang về ${load.incoming}`);
      if (r.ok) bump("wait_reminder");
      else await settings.updateOne({ _id: "notify_state" },   // gửi lỗi → nhả ô để phút sau nhắc lại
        { $unset: { [`wait_reminder.${key}`]: "" } });
    }
  });

  // ── (6) ⚠️ Job KẸT — cần người xử lý (stage lỗi KHÔNG tự thử lại được) ──
  await step("stuck", async () => {
    // Tín hiệu rõ nhất "cần bạn": 1 bước failed với error.retryable=false (hết quota, bị lọc
    // an toàn, VPN/WARP chặn TLS, thiếu cấu hình…). Báo ĐÚNG 1 lần/job (cờ notify.stuck_sent);
    // job hồi phục (không còn lỗi) → nhả cờ để lần sau kẹt lại còn báo tiếp.
    const STUCK_LANES = ["download", "rewrite", "tts", "cut", "convert", "publish"];
    const LANE_VN = {
      download: "Tải video", rewrite: "Viết lại srt", tts: "TTS/MiniMax",
      cut: "Cắt clip", convert: "Convert", publish: "Đăng video",
    };
    const stuckOr = STUCK_LANES.map((ln) => ({
      [`stages.${ln}.status`]: "failed", [`stages.${ln}.error.retryable`]: false,
    }));
    const stuck = await jobs.find(
      { $or: stuckOr, "control.desired": { $ne: "deleted" },
        "notify.stuck_sent": { $ne: true } },
      { projection: { owner_machine: 1, devices: 1, stages: 1 } }).limit(30).toArray();
    for (const c of stuck) {
      const claim = await jobs.findOneAndUpdate(
        { _id: c._id, $or: stuckOr, "notify.stuck_sent": { $ne: true } },
        { $set: { "notify.stuck_sent": true, "notify.stuck_at": new Date() } });
      if (!claim) continue;
      const ln = STUCK_LANES.find(
        (l) => c.stages?.[l]?.status === "failed" && c.stages[l]?.error?.retryable === false);
      const reason = (c.stages?.[ln]?.error?.reason || "không rõ").slice(0, 200);
      const localName = await machineName(localOf(c));
      const r = await send(
        `⚠️ <b>Task [${escapeHtml(c._id)}]</b> — CẦN BẠN XỬ LÝ\n` +
        `🖥 Máy: <b>${escapeHtml(localName)}</b>\n` +
        `❌ Bước: <b>${escapeHtml(LANE_VN[ln] || ln)}</b> — ${escapeHtml(reason)}\n` +
        `👉 Mở app, khắc phục rồi bấm '🔄 Thử lại'`);
      if (r.ok) bump("stuck_alert");
      else await jobs.updateOne({ _id: c._id },
        { $unset: { "notify.stuck_sent": "", "notify.stuck_at": "" } });
    }
    // nhả cờ cho job đã HỒI PHỤC (không còn bước nào failed-không-retry) → kẹt lại sẽ báo tiếp
    await jobs.updateMany(
      { "notify.stuck_sent": true, $nor: stuckOr },
      { $unset: { "notify.stuck_sent": "", "notify.stuck_at": "" } });
  });

  return NextResponse.json({ ok: true, ...counts,
    ...(Object.keys(errors).length ? { errors } : {}) });
}

// Bọc để lỗi ngoài dự kiến trả JSON có nội dung (trước đây 500 body RỖNG, log
// Cloudflare Worker không nói được gì) — vẫn 500 để thấy đỏ trên Vercel.
async function safe(req) {
  try { return await handle(req); }
  catch (e) {
    console.error("[notify-tts] hỏng toàn bộ:", e);
    return NextResponse.json(
      { ok: false, error: String(e?.message || e).slice(0, 500) }, { status: 500 });
  }
}

export async function GET(req) { return safe(req); }
export async function POST(req) { return safe(req); }
