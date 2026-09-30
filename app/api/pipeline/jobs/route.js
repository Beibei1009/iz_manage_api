import { makeGroup } from "../../../../lib/pipeline/route";
import { LANES, CONTROL_DESIRED, EVENTS_CAP } from "../../../../lib/pipeline/const";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Field CHỈ dùng ở dialog chi tiết, phình theo thời gian → loại khỏi query bảng.
const LIST_EXCLUDE = { events: 0, rewrite: 0, config: 0, metadata_options: 0 };

function pushEvent(ev) {
  return { events: { $each: [ev], $slice: -EVENTS_CAP } };
}

// Port trung thực từ core/repo.py — job lifecycle (không atomic-claim, xem nhóm claim).
export const POST = makeGroup({
  async insert_job(db, { doc }) {
    if (!doc || typeof doc !== "object") throw new Error("thiếu doc");
    if (!("created_at" in doc)) doc.created_at = new Date();
    await db.collection("jobs").insertOne(doc);
    return doc._id;
  },

  async get_job(db, { job_id }) {
    return db.collection("jobs").findOne({ _id: job_id });
  },

  async all_jobs(db) {
    return db.collection("jobs").find({}).toArray();
  },

  async next_job_id(db) {
    const doc = await db.collection("counters").findOneAndUpdate(
      { _id: "jobid" }, { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    return String((doc && doc.seq) ?? (doc && doc.value && doc.value.seq));
  },

  async job_by_url(db, { url }) {
    return db.collection("jobs").findOne({ "source.url": url, "cleanup.status": { $ne: "purged" } });
  },

  async jobs_by_url(db, { url }) {
    const rows = await db.collection("jobs").find({
      "source.url": url,
      "cleanup.status": { $ne: "purged" },
      "control.desired": { $ne: "deleted" },
    }).toArray();
    rows.sort((a, b) => String(a._id).localeCompare(String(b._id)));
    return rows;
  },

  async jobs_for(db, { machine_id, only_run = true }) {
    const flt = { owner_machine: machine_id };
    if (only_run) flt["control.desired"] = "run";
    return db.collection("jobs").find(flt, { projection: LIST_EXCLUDE }).toArray();
  },

  async delete_job(db, { job_id }) {
    await db.collection("jobs").deleteOne({ _id: job_id });
    return null;
  },

  async set_fields(db, { job_id, fields }) {
    const r = await db.collection("jobs").updateOne({ _id: job_id }, { $set: fields || {} });
    return r.modifiedCount;
  },

  async set_control(db, { job_id, desired, by = "web:manager", reason = null }) {
    if (!CONTROL_DESIRED.includes(desired)) throw new Error(`control.desired không hợp lệ: ${desired}`);
    await db.collection("jobs").updateOne({ _id: job_id }, {
      $set: { "control.desired": desired, "control.requested_by": by, "control.reason": reason },
      $currentDate: { "control.requested_at": true },
    });
    return null;
  },

  async set_stage(db, { job_id, lane, new_status, extra = null, event = true }) {
    if (!LANES[lane] || !LANES[lane].includes(new_status)) {
      throw new Error(`status ${new_status} không hợp lệ cho ${lane}`);
    }
    const set = { [`stages.${lane}.status`]: new_status, [`stages.${lane}.lease`]: null };
    if (extra) for (const k of Object.keys(extra)) set[`stages.${lane}.${k}`] = extra[k];
    const ops = {
      $set: set,
      $currentDate: { updated_at: true, [`stages.${lane}.updated_at`]: true },
    };
    if (event) ops.$push = pushEvent({ stage: lane, to: new_status });
    const r = await db.collection("jobs").updateOne({ _id: job_id }, ops);
    return r.modifiedCount;
  },

  // worker/cleanup.py::_shared_export — task KHÁC có trỏ cùng file export không.
  async count_capcut_export(db, { jid, path }) {
    return db.collection("jobs").countDocuments({ _id: { $ne: jid }, "artifacts.capcut_export": path });
  },

  // admin/fix_drive_perms.py::collect — link Drive (final + shorts) của mọi job.
  async jobs_drive_links(db) {
    return db.collection("jobs").find({}, { projection: { final: 1, "shorts.items": 1 } }).toArray();
  },

  async pin_jobs_root(db, { machine_id, root }) {
    if (!root || !machine_id) return 0;
    const r = await db.collection("jobs").updateMany(
      {
        owner_machine: machine_id,
        "cleanup.status": { $ne: "purged" },
        $or: [
          { "local.jobs_root": null }, { "local.jobs_root": { $exists: false } },
          { local: null }, { local: { $exists: false } },
        ],
      },
      { $set: { "local.jobs_root": root } }
    );
    return r.modifiedCount;
  },
});
