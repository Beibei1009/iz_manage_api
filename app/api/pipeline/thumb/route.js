import { makeGroup } from "../../../../lib/pipeline/route";
import { TG } from "../../../../lib/pipeline/const";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Guard: chỉ đúng máy đang giữ ĐÚNG lượt (batch) này mới ghi được.
const guard = (job_id, machine_id, batch) => ({
  _id: job_id, "thumb_gen.state": TG.GENERATING,
  "thumb_gen.claimed_by": machine_id, "thumb_gen.batch": parseInt(batch, 10),
});

// Port trung thực từ core/repo.py — TẠO THUMBNAIL.
export const POST = makeGroup({
  async ensure_thumb_index(db) {
    try {
      await db.collection("jobs").createIndex({ "thumb_gen.state": 1 }, { name: "thumb_gen_state_1", sparse: true });
      return true;
    } catch { return false; }
  },

  async get_gdrive_settings(db) {
    return db.collection("settings").findOne({ _id: "gdrive" });
  },

  async get_thumb_template(db, { template_id }) {
    if (!template_id) return null;
    return db.collection(TG.TEMPLATES).findOne({ _id: template_id });
  },

  async thumb_claim(db, { machine_id, lease_seconds = TG.LEASE_SECONDS }) {
    const jobs = db.collection("jobs");
    const now = new Date();
    // Task chết ngang quá MAX_ATTEMPTS lần → dừng hẳn (có ảnh thì READY, không thì FAILED).
    await jobs.updateMany(
      { "thumb_gen.state": TG.GENERATING, "thumb_gen.lease_until": { $lt: now }, "thumb_gen.attempts": { $gte: TG.MAX_ATTEMPTS } },
      [{
        $set: {
          "thumb_gen.state": { $cond: [{ $gt: [{ $size: { $ifNull: ["$thumb_gen.candidates", []] } }, 0] }, TG.READY, TG.FAILED] },
          "thumb_gen.error": `Máy tạo ảnh bị ngắt giữa chừng ${TG.MAX_ATTEMPTS} lần — bấm tạo lại`,
          "thumb_gen.claimed_by": null, "thumb_gen.lease_until": null,
        },
      }]
    );
    const flt = {
      "control.desired": { $ne: "deleted" },
      $or: [
        { "thumb_gen.state": TG.QUEUED },
        { "thumb_gen.state": TG.GENERATING, "thumb_gen.lease_until": { $lt: now } },
      ],
    };
    return jobs.findOneAndUpdate(
      flt,
      {
        $set: {
          "thumb_gen.state": TG.GENERATING, "thumb_gen.claimed_by": machine_id,
          "thumb_gen.lease_until": new Date(now.getTime() + Number(lease_seconds) * 1000),
          "thumb_gen.started_at": now,
        },
        $inc: { "thumb_gen.attempts": 1 },
      },
      { sort: { "thumb_gen.requested_at": 1 }, projection: { thumb_gen: 1, source: 1 }, returnDocument: "after" }
    );
  },

  async thumb_reset_candidates(db, { job_id, batch }) {
    const r = await db.collection("jobs").updateOne(
      { _id: job_id, "thumb_gen.batch": parseInt(batch, 10) },
      { $set: { "thumb_gen.candidates": [] } }
    );
    return r.modifiedCount;
  },

  async thumb_touch(db, { job_id, machine_id, batch, progress = null, lease_seconds = TG.LEASE_SECONDS }) {
    const set = { "thumb_gen.lease_until": new Date(Date.now() + Number(lease_seconds) * 1000) };
    if (progress !== null && progress !== undefined) set["thumb_gen.progress"] = progress;
    const r = await db.collection("jobs").updateOne(guard(job_id, machine_id, batch), { $set: set });
    return r.matchedCount > 0;
  },

  async thumb_add_candidate(db, { job_id, machine_id, batch, cand, lease_seconds = TG.LEASE_SECONDS }) {
    const r = await db.collection("jobs").updateOne(guard(job_id, machine_id, batch), {
      $push: { "thumb_gen.candidates": cand },
      $set: { "thumb_gen.lease_until": new Date(Date.now() + Number(lease_seconds) * 1000) },
    });
    return r.matchedCount > 0;
  },

  async thumb_finish(db, { job_id, machine_id, batch, error = null }) {
    const has = { $gt: [{ $size: { $ifNull: ["$thumb_gen.candidates", []] } }, 0] };
    const r = await db.collection("jobs").updateOne(guard(job_id, machine_id, batch), [{
      $set: {
        "thumb_gen.state": { $cond: [has, TG.READY, TG.FAILED] },
        "thumb_gen.error": error
          ? { $literal: String(error).slice(0, 300) }
          : { $cond: [has, null, "Không tạo được ảnh nào"] },
        "thumb_gen.claimed_by": null, "thumb_gen.lease_until": null,
        "thumb_gen.finished_at": "$$NOW",
      },
    }]);
    return r.matchedCount > 0;
  },
});
