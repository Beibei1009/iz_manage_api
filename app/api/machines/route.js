import { getDb } from "../../../lib/mongo";
import { TTS_BUCKET_OF, TTS_BUCKETS } from "../../../lib/newjob";
import { memo } from "../../../lib/cache";

export const dynamic = "force-dynamic";

// CACHE 3s: bảng poll dày; giảm tải Atlas M0.
export async function GET() {
  return Response.json(await memo("machines", 3000, machinesPayload));
}

async function machinesPayload() {
  const db = await getDb();
  const NOT_PURGED = { "cleanup.status": { $ne: "purged" } };
  // Trước đây kéo TOÀN BỘ ~800 doc job về rồi mới đếm bằng JS (jobs.filter lồng trong
  // machines.map = O(máy × job)). Giờ ĐẾM NGAY TRÊN ATLAS bằng 1 lượt $facet: chỉ vài
  // chục dòng {_id, n} chạy qua mạng thay vì cả trăm KB mỗi 8 giây.
  const machineExpr = {
    pipe: { $ifNull: ["$owner_machine", "$devices.pipeline"] },
    vps: { $ifNull: ["$devices.vps", { $ifNull: ["$tts_target", "$tts.owner"] }] },
  };
  const [machines, [agg]] = await Promise.all([
    db.collection("machines").find({}).sort({ role: 1, name: 1 }).toArray(),
    db.collection("jobs").aggregate([
      { $match: NOT_PURGED },
      { $facet: {
        // (a) tải làn TTS: nhóm theo (máy đích, trạng thái tts)
        tts: [
          { $match: { "control.desired": "run",
                      "stages.tts.status": { $in: Object.keys(TTS_BUCKET_OF) } } },
          { $group: { _id: {
              t: { $cond: [{ $in: ["$tts_target", [null, ""]] },
                           "__pool__", "$tts_target"] },
              s: "$stages.tts.status" }, n: { $sum: 1 } } },
        ],
        // (b) số job mỗi máy đang dính (pipeline HOẶC vps)
        active: [
          { $project: { ids: { $setUnion: [[machineExpr.pipe], [machineExpr.vps]] } } },
          { $unwind: "$ids" },
          { $match: { ids: { $nin: [null, ""] } } },
          { $group: { _id: "$ids", n: { $sum: 1 } } },
        ],
      } },
    ]).toArray(),
  ]);

  // gom job TTS đang bay theo (máy đích → nhóm). tts_target rỗng = pool chung.
  const zero = () =>
    Object.fromEntries([...Object.keys(TTS_BUCKETS), "total"].map((k) => [k, 0]));
  const load = {};
  for (const row of agg?.tts || []) {
    const bucket = TTS_BUCKET_OF[row._id.s];
    if (!bucket) continue;
    const key = row._id.t;
    load[key] ||= zero();
    load[key][bucket] += row.n;
    load[key].total += row.n;
  }
  const pool = load.__pool__?.total || 0;
  const activeOf = {};
  for (const row of agg?.active || []) activeOf[row._id] = row.n;

  const now = Date.now();
  const out = machines.map((m) => {
    const isVps = (m.tool || m.role) === "vps_listener" || m.role === "vps";
    const hb = m.last_heartbeat ? new Date(m.last_heartbeat).getTime() : 0;
    const row = {
      machine_id: m._id, name: m.name || m._id,
      tool: m.tool || (isVps ? "vps_listener" : "pipeline"),
      role: m.role, hostname: m.hostname, os: m.os,
      online: hb && now - hb < 180000,
      last_heartbeat: m.last_heartbeat, jobs_active: activeOf[m._id] || 0,
    };
    if (isVps) {
      row.tts = { ...zero(), ...(load[m._id] || {}), unassigned_pool: pool };
      // trạng thái MiniMax do CHÍNH listener đo (hoạt động ghi file mp3) rồi đăng lên
      row.minimax = m.minimax?.state || null;
      row.minimax_free = m.minimax?.free ?? null;
      // đã bấm Start (loop nền đang nghe) chưa — listener tự báo ở heartbeat
      row.listening = m.listening ?? null;
    }
    return row;
  });
  return out;
}
