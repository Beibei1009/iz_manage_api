import { getDb } from "../../../../lib/mongo";
import { ACTION_MAP } from "../../../../lib/newjob";
import { isAuthed, requireUser } from "../../../../lib/gate";
import { driveDoc, dropFiles, ensureFolder, makePublicReader, thumbUrl, uploadFile, viewUrl } from "../../../../lib/gdrive";

export const dynamic = "force-dynamic";

// Các bước "đang bay" của việc chuyển task (mirror iz_pipeline/core/transfer.py :: INFLIGHT)
const INFLIGHT = ["requested", "packing", "uploading", "ready", "downloading"];

function thumbOf(s = {}) {
  if (s.thumbnail_link) return s.thumbnail_link;
  if (s.video_id) return `https://img.youtube.com/vi/${s.video_id}/hqdefault.jpg`;
  return null;
}

// GET → toàn bộ tài nguyên (text + link) của 1 job để hiển thị chi tiết
export async function GET(req, { params }) {
  const db = await getDb();
  const j = await db.collection("jobs").findOne({ _id: params.id });
  if (!j) return Response.json({ error: "not found" }, { status: 404 });
  const machines = await db.collection("machines").find({}).toArray();
  const names = {};
  for (const m of machines) names[m._id] = m.name || m._id;
  const stages = {};
  for (const k of Object.keys(j.stages || {})) stages[k] = j.stages[k].status;
  const meta = j.metadata_options || {};
  const pipeId = j.owner_machine || j.devices?.pipeline || null;
  const vpsId = j.devices?.vps || j.tts_target || j.tts?.owner || null;
  const link = j.final?.video_link || null;
  const hasLink = link && String(link).startsWith("http");
  const driveId = j.final?.drive_id || (link ? (String(link).match(/\/d\/([^/]+)/)?.[1] || null) : null);
  const thumbLink = j.final?.thumbnail_link || null;
  const thumbId = j.final?.thumbnail_drive_id
    || (thumbLink ? (String(thumbLink).match(/\/d\/([^/]+)/)?.[1] || null) : null);
  // Máy LOCAL (operator) — nguồn chọn khi chuyển task. VPS listener KHÔNG nằm ở đây:
  // nó chỉ chạy MiniMax, không có worker để chạy tiếp pipeline.
  const now = Date.now();
  const locals = machines
    .filter((m) => (m.role || "") === "local")
    .map((m) => ({
      id: m._id, name: m.name || m._id,
      online: !!(m.last_heartbeat && now - new Date(m.last_heartbeat).getTime() < 180000),
    }))
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  const tf = j.transfer || null;
  return Response.json({
    id: j._id, phase: j.overall_phase, waiting_on: j.waiting_on,
    next_action: j.next_action, desired: j.control?.desired,
    owner_id: pipeId, locals,
    // TẠO THUMBNAIL — trạng thái + ảnh ứng viên (ảnh công khai, xem được không cần đăng nhập)
    thumb: j.thumb_gen ? {
      state: j.thumb_gen.state, batch: j.thumb_gen.batch || 0,
      hook: j.thumb_gen.hook || "", hook_source: j.thumb_gen.hook_source || null,
      template_id: j.thumb_gen.template_id || null, n: j.thumb_gen.n || null,
      error: j.thumb_gen.error || null, progress: j.thumb_gen.progress || null,
      requested_at: j.thumb_gen.requested_at || null,
      claimed_by: j.thumb_gen.claimed_by ? (names[j.thumb_gen.claimed_by] || j.thumb_gen.claimed_by) : null,
      chosen_drive_id: j.thumb_gen.chosen_drive_id || null,
      candidates: (j.thumb_gen.candidates || []).map((c) => ({
        drive_id: c.drive_id, img: thumbUrl(c.drive_id, 640), full: thumbUrl(c.drive_id, 1600),
        batch: c.batch, idx: c.idx, variant: c.variant || "", placement: c.placement || "",
        ocr_ok: typeof c.ocr_ok === "boolean" ? c.ocr_ok : null, ocr_text: c.ocr_text || "",
      })),
    } : null,
    transfer: tf && { state: tf.state, from: tf.from, to: tf.to,
                      from_name: names[tf.from] || tf.from,
                      to_name: names[tf.to] || tf.to,
                      size: tf.size || 0, error: tf.error || null,
                      attempts: tf.attempts || 0 },
    queue: j.queue, stages, counts: j.counts,
    note: j.note || "",          // ghi chú user (đồng bộ 2 chiều với Operator)
    pipeline_name: pipeId ? (names[pipeId] || pipeId) : "—",
    vps_name: vpsId ? (names[vpsId] || vpsId) : "chưa gán",
    source: {
      url: j.source?.url || null,
      title_original: j.source?.title_original || null,
      video_id: j.source?.video_id || null,
      thumbnail: thumbOf(j.source),
    },
    final: {
      link, has_link: hasLink,
      drive_id: driveId,
      embed: driveId ? `https://drive.google.com/file/d/${driveId}/preview` : null,
      thumbnail: thumbLink,
      thumbnail_img: thumbId ? `https://drive.google.com/thumbnail?id=${thumbId}&sz=w640` : null,
      published_at: j.final?.published_at || null,
    },
    drive_in_link: j.tts?.drive_in_link || null,
    titles: meta.titles || [],
    hooks: meta.hooks || [],
    descriptions: meta.descriptions || [],
    title_scores: meta.title_scores || [],   // điểm CTR Gemini tự chấm (song song titles)
    title_notes: meta.title_notes || [],     // "vì sao đáng click" (song song titles)
    chosen_title_idx: (meta.chosen_title_idx ?? null),
    chosen_desc_idx: (meta.chosen_desc_idx ?? null),
    warnings: (j.rewrite?.warnings || []),
    // đã mở khoá (đăng nhập ở trang /keys) → web mới cho CHỌN tiêu đề/hook/mô tả
    authed: isAuthed(req),
  });
}

// POST { control: "paused"|"stopped"|"deleted"|"run" }  hoặc  { action: "approve_review"|... }
export async function POST(req, { params }) {
  const jid = params.id;
  const body = await req.json();
  const db = await getDb();
  const jobs = db.collection("jobs");

  if (body.control) {
    const allowed = ["run", "paused", "stopped", "deleted"];
    if (!allowed.includes(body.control))
      return Response.json({ error: "control không hợp lệ" }, { status: 400 });
    await jobs.updateOne({ _id: jid }, {
      $set: { "control.desired": body.control, "control.requested_by": "web:manager" },
      $currentDate: { "control.requested_at": true },
    });
    return Response.json({ ok: true });
  }

  // Ghi chú: sửa trên web, Operator đọc cùng field job.note (không cần nút Lưu)
  if (typeof body.note === "string") {
    if (body.note.length > 2000)
      return Response.json({ error: "ghi chú quá dài (>2000 ký tự)" }, { status: 400 });
    const r = await jobs.updateOne({ _id: jid }, {
      $set: { note: body.note.trim() }, $currentDate: { updated_at: true },
    });
    if (!r.matchedCount) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true, note: body.note.trim() });
  }

  // Ghép chữ trên web (editor canvas) → upload ảnh JPEG lên Drive (tài khoản trung tâm) → lưu link
  // vào task làm thumbnail cuối (Operator dùng để up YouTube) + ghi vào thumb_gen.edited. PHẢI ĐĂNG NHẬP.
  if (body.thumb_compose) {
    const gate = requireUser(req);
    if (gate) return gate;
    const { image, name } = body.thumb_compose;
    if (!image || typeof image !== "string") return Response.json({ error: "thiếu ảnh" }, { status: 400 });
    let buffer;
    try { buffer = Buffer.from(image, "base64"); } catch { return Response.json({ error: "ảnh không hợp lệ" }, { status: 400 }); }
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) return Response.json({ error: "ảnh rỗng hoặc quá lớn (>8MB)" }, { status: 413 });
    if (!(await jobs.findOne({ _id: jid }, { projection: { _id: 1 } }))) return Response.json({ error: "not found" }, { status: 404 });
    let driveId;
    try {
      const parent = await ensureFolder(db, "thumbnails");
      const fname = String(name || `thumb-${jid}-${Date.now()}`).replace(/[^\w.-]/g, "_").slice(0, 80) + ".jpg";
      driveId = await uploadFile(db, { name: fname, mime: "image/jpeg", buffer, parent });
      await makePublicReader(db, driveId);
    } catch (e) {
      return Response.json({ error: `Drive: ${e.message || e}` }, { status: e.status || 500 });
    }
    await jobs.updateOne({ _id: jid }, {
      $set: { "final.thumbnail_drive_id": driveId, "final.thumbnail_link": viewUrl(driveId) },
      $push: { "thumb_gen.edited": { drive_id: driveId, at: new Date() } },
      $currentDate: { updated_at: true },
    });
    return Response.json({ ok: true, drive_id: driveId, link: viewUrl(driveId), img: thumbUrl(driveId, 640) });
  }

  // CHỌN tiêu đề/hook/mô tả chính từ web — ghi đúng field Operator đang đọc
  // (metadata_options.chosen_*), nên 2 bên đồng bộ tức thì. PHẢI ĐĂNG NHẬP: đây là
  // quyết định nội dung sẽ đăng, không để người lạ mở URL là sửa được.
  if (body.choose) {
    const gate = requireUser(req);
    if (gate) return gate;
    const j = await jobs.findOne({ _id: jid }, { projection: { metadata_options: 1 } });
    if (!j) return Response.json({ error: "not found" }, { status: 404 });
    const meta = j.metadata_options || {};
    const set = {};
    // null = BỎ CHỌN. Số phải nằm trong mảng thật (index rác → Operator hiện sai cặp).
    for (const [key, field, arr] of [
      ["title_idx", "chosen_title_idx", meta.titles || []],
      ["desc_idx", "chosen_desc_idx", meta.descriptions || []],
    ]) {
      if (!(key in body.choose)) continue;
      const v = body.choose[key];
      if (v === null) { set[`metadata_options.${field}`] = null; continue; }
      if (!Number.isInteger(v) || v < 0 || v >= arr.length)
        return Response.json({ error: `${key} ngoài phạm vi (0..${arr.length - 1})` },
          { status: 400 });
      set[`metadata_options.${field}`] = v;
    }
    if (!Object.keys(set).length)
      return Response.json({ error: "thiếu title_idx/desc_idx" }, { status: 400 });
    await jobs.updateOne({ _id: jid }, {
      $set: set, $currentDate: { updated_at: true },
      $push: { events: { $each: [{ stage: "metadata", to: "chosen", by: "web:manager",
                                   detail: set }], $slice: -50 } },
    });
    return Response.json({ ok: true, ...set });
  }

  // ── TẠO THUMBNAIL ─────────────────────────────────────────────────────────────
  // Web chỉ ghi trạng thái; extension (qua cầu nối 127.0.0.1 của tool pipeline) nhận việc.
  // Ảnh ứng viên thuộc tài khoản Drive TRUNG TÂM → web là chủ nên xoá được ảnh không chọn.
  const THUMB_ACTIVE = ["queued", "generating"];
  if (body.thumb_submit) {
    const gate = requireUser(req);
    if (gate) return gate;
    const b = body.thumb_submit;
    // Extension chỉ tạo ẢNH NỀN → hook & mẫu chữ KHÔNG bắt buộc (chữ do user tự thêm ở web).
    // Vẫn lưu hook đã chọn (nếu có) để tham chiếu; template_id tuỳ chọn.
    const hook = String(b.hook || "").normalize("NFC").replace(/\s+/g, " ").trim();
    if (hook.length > 80) return Response.json({ error: "hook quá 80 ký tự" }, { status: 400 });
    const n = Number(b.n);
    if (!Number.isInteger(n) || n < 1 || n > 40) return Response.json({ error: "số ảnh phải từ 1 đến 40" }, { status: 400 });
    let tpl = null;
    if (b.template_id) tpl = await db.collection("thumb_templates").findOne({ _id: String(b.template_id) });
    const gd = await driveDoc(db);
    if (!gd?.refresh_token) return Response.json({ error: "web chưa đăng nhập Google Drive (/keys → ☁ Google Drive)" }, { status: 409 });
    const j = await jobs.findOne({ _id: jid }, { projection: { thumb_gen: 1, control: 1 } });
    if (!j) return Response.json({ error: "not found" }, { status: 404 });
    if (j.control?.desired === "deleted") return Response.json({ error: "task đã bị xoá" }, { status: 409 });
    const prev = j.thumb_gen || {};
    if (THUMB_ACTIVE.includes(prev.state)) return Response.json({ error: "đang có lượt tạo chạy dở" }, { status: 409 });
    const set = {
      "thumb_gen.state": "queued", "thumb_gen.batch": (prev.batch || 0) + 1,
      "thumb_gen.hook": hook, "thumb_gen.hook_source": b.hook_source === "manual" ? "manual" : "generated",
      "thumb_gen.template_id": tpl?._id || null, "thumb_gen.n": n,
      "thumb_gen.requested_at": new Date(), "thumb_gen.requested_by": "web:manager",
      "thumb_gen.error": null, "thumb_gen.progress": null, "thumb_gen.attempts": 0,
      "thumb_gen.claimed_by": null, "thumb_gen.lease_until": null,
    };
    // Đang "chờ chọn" mà bấm tạo tiếp = GEN THÊM: giữ ảnh cũ để so. Mọi trạng thái khác
    // (đã chọn / huỷ / lỗi) bắt đầu lại từ danh sách trống.
    if (prev.state !== "ready") set["thumb_gen.candidates"] = [];
    const r = await jobs.updateOne({ _id: jid, $or: [{ thumb_gen: { $exists: false } }, { "thumb_gen.state": { $nin: THUMB_ACTIVE } }] },
      { $set: set, $currentDate: { updated_at: true } });
    if (!r.matchedCount) return Response.json({ error: "vừa có lượt tạo khác chen vào — tải lại" }, { status: 409 });
    if (tpl?._id) await db.collection("thumb_templates").updateOne({ _id: tpl._id }, { $inc: { uses: 1 } });
    return Response.json({ ok: true, batch: set["thumb_gen.batch"] });
  }

  if (body.thumb_cancel) {
    const gate = requireUser(req);
    if (gate) return gate;
    // ĐỔI TRẠNG THÁI TRƯỚC, XOÁ FILE SAU: ảnh tool pipeline upload sau thời điểm này sẽ bị
    // từ chối ghi (guard state=generating) và tự xoá → không có ảnh nào lọt ra ngoài danh sách.
    const before = await jobs.findOneAndUpdate(
      { _id: jid, "thumb_gen.state": { $in: [...THUMB_ACTIVE, "ready"] } },
      { $set: { "thumb_gen.state": "cancelled", "thumb_gen.candidates": [], "thumb_gen.claimed_by": null,
                "thumb_gen.lease_until": null, "thumb_gen.error": null } },
      { returnDocument: "before", projection: { thumb_gen: 1 } });
    if (!before) return Response.json({ error: "không có lượt tạo nào để huỷ" }, { status: 409 });
    const ids = (before.thumb_gen?.candidates || []).map((c) => c.drive_id).filter(Boolean);
    const res = ids.length ? await dropFiles(db, ids, jid) : { deleted: 0, failed: 0 };
    return Response.json({ ok: true, ...res });
  }

  if (body.thumb_choose) {
    const gate = requireUser(req);
    if (gate) return gate;
    const id = String(body.thumb_choose.drive_id || "");
    if (!id) return Response.json({ error: "thiếu drive_id" }, { status: 400 });
    // Chọn = ghi final.thumbnail_* (đúng 3 field nút "Upload thumbnail" của operator đang ghi)
    // + bỏ các ứng viên khác khỏi danh sách, NGUYÊN TỬ. Xoá file trên Drive làm sau.
    const before = await jobs.findOneAndUpdate(
      { _id: jid, "thumb_gen.state": "ready", "thumb_gen.candidates.drive_id": id },
      { $set: { "thumb_gen.state": "done", "thumb_gen.chosen_drive_id": id, "thumb_gen.chosen_at": new Date(),
                "final.thumbnail_drive_id": id, "final.thumbnail_link": viewUrl(id) },
        $pull: { "thumb_gen.candidates": { drive_id: { $ne: id } } },
        $currentDate: { updated_at: true } },
      { returnDocument: "before", projection: { thumb_gen: 1 } });
    if (!before) return Response.json({ error: "ảnh không còn trong danh sách chờ chọn (đã chọn / huỷ / đang tạo thêm?)" }, { status: 409 });
    const chosen = (before.thumb_gen?.candidates || []).find((c) => c.drive_id === id);
    if (chosen?.key) await jobs.updateOne({ _id: jid }, { $set: { "final.thumbnail_key": chosen.key } });
    const others = (before.thumb_gen?.candidates || []).map((c) => c.drive_id).filter((x) => x && x !== id);
    const res = others.length ? await dropFiles(db, others, jid) : { deleted: 0, failed: 0 };
    return Response.json({ ok: true, ...res });
  }

  // CHUYỂN TASK SANG MÁY KHÁC. Web chỉ ĐẶT LỆNH; hai máy operator tự bắt tay qua Drive
  // (iz_pipeline/worker/transfer_runner.py). Phải ĐĂNG NHẬP: lệnh này làm task rời khỏi
  // máy đang giữ file, không để người lạ mở URL là bấm được.
  if (body.transfer_to) {
    const gate = requireUser(req);
    if (gate) return gate;
    const to = String(body.transfer_to);
    const target = await db.collection("machines").findOne({ _id: to },
      { projection: { role: 1, name: 1 } });
    if (!target || target.role !== "local")
      return Response.json({ error: "máy đích không phải máy local (operator)" }, { status: 400 });
    const j = await jobs.findOne({ _id: jid },
      { projection: { owner_machine: 1, devices: 1, transfer: 1, control: 1 } });
    if (!j) return Response.json({ error: "not found" }, { status: 404 });
    if ((j.control?.desired) === "deleted")
      return Response.json({ error: "task đã bị xoá" }, { status: 409 });
    if (INFLIGHT.includes(j.transfer?.state))
      return Response.json({ error: `task đang chuyển dở (${j.transfer.state})` }, { status: 409 });
    const from = j.owner_machine || j.devices?.pipeline || null;
    if (from === to)
      return Response.json({ error: "task vốn đã ở máy này" }, { status: 409 });
    // Lệnh mới ghi đè cả object `transfer` → id gói Drive của lượt TRƯỚC mất theo. Gói đó
    // chưa được chủ nó (máy nguồn cũ) xoá thì ghi lại, máy đó mở app sẽ tự dọn. Chỉ CHỦ
    // file mới xoá được trên Drive nên không thể để máy khác làm hộ.
    const prev = j.transfer || {};
    const carryOld = (prev.drive_id && !prev.pkg_deleted && prev.from)
      ? { transfer_old_pkgs: { from: prev.from, drive_id: prev.drive_id, key: prev.key || null } }
      : {};
    // Có điều kiện: hai admin bấm cùng lúc thì người sau phải bị từ chối, không phải
    // ghi đè lệnh của người trước (mỗi lệnh trỏ một máy đích khác nhau).
    const r = await jobs.updateOne({ _id: jid,
      $or: [{ transfer: { $exists: false } }, { transfer: null },
            { "transfer.state": { $nin: INFLIGHT } }] }, {
      // requested_at đặt THẲNG trong object. Mongo từ chối nếu vừa $set cả `transfer`
      // vừa $currentDate `transfer.requested_at` ("would create a conflict at 'transfer'").
      $set: { transfer: { state: "requested", from, to, requested_by: "web:manager",
                          attempts: 0, error: null, requested_at: new Date(),
                          key: `transfer/${jid}.zip` } },
      $currentDate: { updated_at: true },
      $push: { events: { $each: [{ stage: "transfer", to: "requested", by: "web:manager",
                                   detail: { from, to } }], $slice: -50 }, ...carryOld },
    });
    if (!r.matchedCount)
      return Response.json({ error: "vừa có lệnh chuyển khác chen vào — tải lại rồi thử lại" },
        { status: 409 });
    return Response.json({ ok: true, from, to, to_name: target.name || to });
  }

  // HUỶ lệnh chuyển — được phép ở MỌI bước đang bay, kể cả khi máy nguồn đang nén hay
  // máy đích đang tải. An toàn vì phía pipeline chỉ đổi state bằng cập-nhật-có-điều-kiện
  // (advance_transfer / finish_transfer): bên nào thấy state đã thành 'cancelled' thì tự
  // dừng và dọn phần dở của mình (xoá gói vừa nén, gói đã lỡ lên Drive, folder vừa bung).
  // Đây cũng là lối thoát duy nhất khi một trong hai máy tắt hẳn giữa chừng.
  if (body.transfer_cancel) {
    const gate = requireUser(req);
    if (gate) return gate;
    const r = await jobs.updateOne(
      { _id: jid, "transfer.state": { $in: [...INFLIGHT, "failed"] } },
      { $set: { "transfer.state": "cancelled" }, $currentDate: { "transfer.updated_at": true } });
    if (!r.matchedCount)
      return Response.json({ error: "không có lệnh chuyển nào đang chạy" }, { status: 409 });
    return Response.json({ ok: true });
  }

  if (body.action && ACTION_MAP[body.action]) {
    const [lane, status] = ACTION_MAP[body.action];
    await jobs.updateOne({ _id: jid }, {
      $set: { [`stages.${lane}.status`]: status, [`stages.${lane}.lease`]: null },
      $currentDate: { updated_at: true, [`stages.${lane}.updated_at`]: true },
      $push: { events: { stage: lane, to: status, by: "web:manager" } },
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "thiếu control/action" }, { status: 400 });
}
