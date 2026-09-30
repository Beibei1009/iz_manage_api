import { getDb } from "../../../lib/mongo";
import { newJob } from "../../../lib/newjob";
import { memo, invalidate } from "../../../lib/cache";
import crypto from "crypto";

export const dynamic = "force-dynamic";

function thumbOf(j) {
  // Ưu tiên ảnh bìa user tự upload (Drive) → dùng URL render được của Drive
  const tId = j.final?.thumbnail_drive_id
    || (j.final?.thumbnail_link ? (String(j.final.thumbnail_link).match(/\/d\/([^/]+)/)?.[1] || null) : null);
  if (tId) return `https://drive.google.com/thumbnail?id=${tId}&sz=w320`;
  const s = j.source || {};
  if (s.video_id) return `https://img.youtube.com/vi/${s.video_id}/hqdefault.jpg`;
  if (s.thumbnail_link) return s.thumbnail_link;
  return null;
}

function mapJob(j, names) {
  // stages đã được rút còn {lane: status} ngay trên Atlas (xem $project) — không còn
  // phải kéo cả object lease/error/trace của từng làn về rồi mới bóc .status.
  const stages = j.stages || {};
  const pipeId = j.owner_machine || j.devices?.pipeline || null;
  const vpsId = j.devices?.vps || j.tts_target || j.tts?.owner || null;
  const meta = j.metadata_options || {};
  const link = j.final?.video_link || null;
  const hasLink = link && String(link).startsWith("http");
  return {
    id: j._id, queue: j.queue, phase: j.overall_phase, waiting_on: j.waiting_on,
    next_action: j.next_action, machine: j.owner_machine,
    // thời gian START: ưu tiên created_at (job mới, chính xác); job CŨ chưa có field này
    // -> fallback updated_at để vẫn hiển thị 1 mốc thay vì "—".
    created_at: j.created_at || j.updated_at || null,
    created_exact: !!j.created_at,      // true = mốc chính xác, false = xấp xỉ (updated_at)
    updated_at: j.updated_at || null,
    pipeline_id: pipeId, vps_id: vpsId,
    pipeline_name: pipeId ? (names[pipeId] || pipeId) : "—",
    vps_name: vpsId ? (names[vpsId] || vpsId) : "chưa gán",
    desired: j.control?.desired, url: j.source?.url,
    note: j.note || "",          // ghi chú user (sửa ở Operator hoặc ngay trên web này)
    source_title: j.source?.title_original || null,
    thumbnail: thumbOf(j),
    link, has_link: !!hasLink,
    drive_in_link: j.tts?.drive_in_link || null,
    // count tính sẵn ở aggregation ($size); fallback cho doc chưa qua pipeline mới
    // dấu vết dọn dẹp: web hiện được "đã xoá nhưng còn link" / "đã giải phóng"
    cleanup: {
      status: j.cleanup?.status || null,
      keep_drive: !!j.cleanup?.keep_drive,
      level: j.cleanup?.level ?? null,
      freed_bytes: j.cleanup?.freed_bytes ?? 0,
    },
    // đang chuyển máy → bảng phải nói ra, nếu không admin bấm Chuyển xong quay lại
    // danh sách thấy y như cũ và tưởng lệnh rơi vào hư không
    transfer: j.transfer?.state || null,
    thumb: j.thumb_gen?.state || null,       // badge "🖼 chờ chọn" trên bảng
    transfer_to: j.transfer?.to ? (names[j.transfer.to] || j.transfer.to) : null,
    titles_n: j.titles_n ?? (meta.titles || []).length,
    descs_n: j.descs_n ?? (meta.descriptions || []).length,
    counts: j.counts, stages,
  };
}

// Trần số dòng trả về 1 lần. Bảng chỉ xem được vài chục dòng; kéo cả 500+ job mỗi
// nhịp poll là lý do trang treo. Muốn xem sâu hơn thì bấm "tải thêm" (?limit=) hoặc
// gõ tìm kiếm (?q= — lọc NGAY TRÊN ATLAS nên vẫn với tới job cũ ngoài trần).
const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 3000;
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

// CHỈ field bảng dùng tới. Trước đây dùng $project loại trừ (events/rewrite/config/
// metadata_options) — vẫn tha về stages đầy đủ (lease, error, trace), artifacts,
// notify, local… ≈ 3.7 KB/doc thừa. Liệt kê thẳng thứ cần: 1.8 MB → ~0.5 MB.
const PROJECT = {
  queue: 1, overall_phase: 1, waiting_on: 1, next_action: 1, owner_machine: 1,
  created_at: 1, updated_at: 1, note: 1, counts: 1, tts_target: 1,
  "devices.pipeline": 1, "devices.vps": 1,
  "tts.owner": 1, "tts.drive_in_link": 1,
  "control.desired": 1,
  "source.url": 1, "source.title_original": 1, "source.video_id": 1,
  "source.thumbnail_link": 1,
  "final.video_link": 1, "final.thumbnail_drive_id": 1, "final.thumbnail_link": 1,
  cleanup: 1,
  "transfer.state": 1, "transfer.to": 1,
  "thumb_gen.state": 1,
  titles_n: { $size: { $ifNull: ["$metadata_options.titles", []] } },
  descs_n: { $size: { $ifNull: ["$metadata_options.descriptions", []] } },
  // rút stages về {lane: status} ngay trên server
  stages: { $arrayToObject: { $map: {
    input: { $objectToArray: { $ifNull: ["$stages", {}] } },
    as: "s", in: { k: "$$s.k", v: "$$s.v.status" },
  } } },
};

export async function GET(req) {
  // Ẩn job đã xoá/purge (giống operator) — tránh list đầy task ma.
  // ?scope=deleted → xem RIÊNG các task đã xoá mà user chọn GIỮ file Drive: task không
  // còn trên máy nhưng link video/short/srt vẫn dùng được, đây là chỗ duy nhất tra lại.
  const sp = new URL(req.url).searchParams;
  const scope = sp.get("scope");
  const q = (sp.get("q") || "").trim();
  const limit = Math.min(MAX_LIMIT,
    Math.max(1, parseInt(sp.get("limit"), 10) || DEFAULT_LIMIT));
  // CACHE 3s (bảng poll ~6s): giảm tải Atlas M0. Dữ liệu cũ tối đa 3s. Cache theo (scope,q,limit).
  const payload = await memo(`jobs|${scope || ""}|${q}|${limit}`, 3000, () => jobsPayload({ scope, q, limit }));
  return Response.json(payload);
}

async function jobsPayload({ scope, q, limit }) {
  const db = await getDb();
  const activeFilter = scope === "deleted"
    ? { "control.desired": "deleted", "cleanup.keep_drive": true }
    : {
      "cleanup.status": { $ne: "purged" },
      "control.desired": { $ne: "deleted" },
    };
  // Tìm kiếm chạy TRÊN ATLAS (không phải lọc trong trình duyệt) để job cũ nằm ngoài
  // trần vẫn tra được: link · tiêu đề · ghi chú · #id.
  const match = q
    ? { $and: [activeFilter, { $or: [
        { _id: rx(q) }, { "source.url": rx(q) },
        { "source.title_original": rx(q) }, { note: rx(q) },
      ] }] }
    : activeFilter;

  const [jobs, machines, buckets] = await Promise.all([
    db.collection("jobs").aggregate([
      { $match: match },
      { $sort: { updated_at: -1 } },      // dùng index updated_at_-1
      { $limit: limit },
      { $project: PROJECT },
    ]).toArray(),
    db.collection("machines").find({}, { projection: { name: 1 } }).toArray(),
    // 4 ô thống kê ĐẾM TRÊN ATLAS, trên TOÀN BỘ job khớp lọc — không phụ thuộc trần
    // `limit`. (Trước đây đếm trong trình duyệt từ mảng đã tải; giờ chỉ tải 1 trang
    // nên đếm kiểu cũ sẽ thiếu.) Điều kiện phải KHỚP phaseBadge() ở app/page.js.
    db.collection("jobs").aggregate([
      { $match: match },
      { $group: { _id: { $switch: { branches: [
        { case: { $eq: ["$overall_phase", "completed"] }, then: "done" },
        { case: { $eq: ["$overall_phase", "failed"] }, then: "fail" },
        { case: { $regexMatch: { input: { $ifNull: ["$waiting_on", ""] },
                                 regex: "^human" } }, then: "wait" },
      ], default: "run" } }, n: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const names = {};
  for (const m of machines) names[m._id] = m.name || m._id;
  const stats = { run: 0, wait: 0, done: 0, fail: 0 };
  let total = 0;
  for (const b of buckets) { stats[b._id] = b.n; total += b.n; }
  return {
    items: jobs.map((j) => mapJob(j, names)),
    total, limit, q, stats,
  };
}

// enqueue: POST { url, queue?, machine?, tts_target? }
export async function POST(req) {
  const { url, queue = "default", machine, tts_target = null } = await req.json();
  if (!url) return Response.json({ error: "missing url" }, { status: 400 });
  const db = await getDb();

  let owner = machine;
  if (!owner) {
    const m = await db.collection("machines").findOne({ role: "local", status: "online" });
    owner = m?._id;
  }
  if (!owner) return Response.json({ error: "không có máy local online để giao việc" }, { status: 409 });

  const dup = await db.collection("jobs").findOne({ "source.url": url, "cleanup.status": { $ne: "purged" } });
  if (dup) return Response.json({ id: dup._id, dup: true });
  const ctr = await db.collection("counters").findOneAndUpdate(
    { _id: "jobid" }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  const jid = String((ctr.value || ctr).seq);
  await db.collection("jobs").insertOne(newJob(jid, url, owner, queue, 5, tts_target || null));
  invalidate("jobs|"); // tạo job mới → bỏ cache list để hiện ngay
  return Response.json({ id: jid });
}
