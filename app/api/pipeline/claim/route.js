import { makeGroup } from "../../../../lib/pipeline/route";
import { EVENTS_CAP } from "../../../../lib/pipeline/const";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// now/until tính SERVER-SIDE (đồng hồ BE) → mọi máy dùng chung 1 nguồn giờ, không lệch.
const pushEvent = (ev) => ({ events: { $each: [ev], $slice: -EVENTS_CAP } });

// Port trung thực từ core/repo.py — CLAIM ATOMIC (find_one_and_update). lease_seconds
// LUÔN do tool gửi lên (ApiRepo tự resolve từ config), nên ở đây không cần default.
export const POST = makeGroup({
  async claim_stage(db, { lane, from_status, to_status, machine_id, lease_seconds, job_id }) {
    const now = new Date();
    const until = new Date(now.getTime() + Number(lease_seconds) * 1000);
    const lp = `stages.${lane}.lease`;
    const flt = {
      [`stages.${lane}.status`]: from_status,
      "control.desired": "run",
      $or: [
        { [lp]: null }, { [lp]: { $exists: false } },
        { [`${lp}.until`]: { $lt: now } }, { [`${lp}.holder`]: machine_id },
      ],
    };
    if (job_id !== null && job_id !== undefined) flt._id = job_id;
    const upd = {
      $set: {
        [`stages.${lane}.status`]: to_status,
        [lp]: { holder: machine_id, until },
        [`stages.${lane}.owner`]: machine_id,
      },
      $currentDate: { updated_at: true },
      $push: pushEvent({ stage: lane, to: to_status, by: machine_id }),
    };
    return db.collection("jobs").findOneAndUpdate(flt, upd, { returnDocument: "after" });
  },

  async renew_lease(db, { job_id, lane, machine_id, lease_seconds }) {
    const until = new Date(Date.now() + Number(lease_seconds) * 1000);
    await db.collection("jobs").updateOne(
      { _id: job_id, [`stages.${lane}.lease.holder`]: machine_id },
      { $set: { [`stages.${lane}.lease.until`]: until } }
    );
    return null;
  },

  async jobs_for_stage(db, { lane, status, machine_id }) {
    const flt = { [`stages.${lane}.status`]: status, "control.desired": "run" };
    if (machine_id && lane === "tts") flt.tts_target = machine_id;
    return db.collection("jobs").find(flt).toArray();
  },

  async claim_tts(db, { machine_id, lease_seconds }) {
    const now = new Date();
    const until = new Date(now.getTime() + Number(lease_seconds) * 1000);
    const stale = new Date(now.getTime() - Number(lease_seconds) * 1000);
    const lp = "stages.tts.lease";
    const flt = {
      "control.desired": "run",
      $or: [
        {
          "stages.tts.status": "uploaded_to_drive",
          $and: [
            { $or: [{ tts_target: machine_id }, { tts_target: null }, { tts_target: { $exists: false } }] },
            {
              $or: [
                { [lp]: null }, { [lp]: { $exists: false } },
                { [`${lp}.until`]: { $lt: now } }, { [`${lp}.holder`]: machine_id },
              ],
            },
          ],
        },
        {
          "stages.tts.status": { $in: ["claimed_by_vps", "vps_downloading"] },
          updated_at: { $lt: stale },
        },
      ],
    };
    const upd = {
      $set: {
        "stages.tts.status": "claimed_by_vps",
        "stages.tts.owner": machine_id,
        tts_target: machine_id,
        "devices.vps": machine_id,
        [lp]: { holder: machine_id, until },
      },
      $currentDate: { updated_at: true },
      $push: pushEvent({ stage: "tts", to: "claimed_by_vps", by: machine_id }),
    };
    return db.collection("jobs").findOneAndUpdate(flt, upd, { returnDocument: "after" });
  },
});
