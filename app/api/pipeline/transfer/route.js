import { makeGroup } from "../../../../lib/pipeline/route";
import { EVENTS_CAP, TR, TR_INFLIGHT, TR_STATE_LABEL, driveKey } from "../../../../lib/pipeline/const";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const pushEvent = (ev) => ({ events: { $each: [ev], $slice: -EVENTS_CAP } });
const LIST_EXCLUDE = { events: 0, rewrite: 0, config: 0, metadata_options: 0 };

// Port trung thực từ core/repo.py — CHUYỂN TASK giữa máy (state machine).
export const POST = makeGroup({
  async request_transfer(db, { job_id, to_machine, by = "web:manager" }) {
    const jobs = db.collection("jobs");
    const j = await jobs.findOne({ _id: job_id }, { projection: { owner_machine: 1, transfer: 1, control: 1 } });
    if (!j) return { ok: false, reason: "không có task này" };
    if ((j.control || {}).desired === "deleted") return { ok: false, reason: "task đã bị xoá" };
    const cur = (j.transfer || {}).state;
    if (TR_INFLIGHT.includes(cur)) return { ok: false, reason: `task đang chuyển dở (${TR_STATE_LABEL[cur] || cur})` };
    const src = j.owner_machine;
    if (src === to_machine) return { ok: false, reason: "task vốn đã ở máy này" };
    const push = pushEvent({ stage: "transfer", to: TR.REQUESTED, by, detail: { from: src, to: to_machine } });
    const prev = j.transfer || {};
    if (prev.drive_id && !prev.pkg_deleted && prev.from) {
      push.transfer_old_pkgs = { from: prev.from, drive_id: prev.drive_id, key: prev.key };
    }
    await jobs.updateOne({ _id: job_id }, {
      $set: {
        transfer: {
          state: TR.REQUESTED, from: src, to: to_machine, requested_by: by, attempts: 0,
          error: null, requested_at: new Date(), key: driveKey(job_id),
        },
      },
      $currentDate: { updated_at: true },
      $push: push,
    });
    return { ok: true, reason: null };
  },

  async ensure_transfer_index(db) {
    try {
      await db.collection("jobs").createIndex({ "transfer.state": 1 }, { name: "transfer_state_1", sparse: true });
      await db.collection("jobs").createIndex({ "transfer_old_pkgs.from": 1 }, { name: "transfer_old_pkgs_from_1", sparse: true });
      return true;
    } catch { return false; }
  },

  async transfer_work(db, { machine_id }) {
    const SEND = [TR.REQUESTED, TR.PACKING, TR.UPLOADING];
    const RECV = [TR.READY, TR.DOWNLOADING];
    const ENDED = [TR.DONE, TR.FAILED, TR.CANCELLED];
    const cur = db.collection("jobs").find({
      $or: [
        { "transfer.from": machine_id, "transfer.state": { $in: SEND } },
        { "transfer.to": machine_id, "transfer.state": { $in: RECV } },
        {
          "transfer.from": machine_id, "transfer.state": { $in: ENDED },
          "transfer.drive_id": { $nin: [null, ""] },
          "transfer.pkg_deleted": { $ne: true }, "transfer.pkg_gave_up": { $ne: true },
        },
        { "transfer.from": machine_id, "transfer.state": TR.DONE, "transfer.src_purged": { $ne: true } },
        { "transfer_old_pkgs.from": machine_id },
      ],
    }, { projection: LIST_EXCLUDE });
    const out = { send: [], recv: [], package: [], cleanup: [], old_pkgs: [] };
    for await (const j of cur) {
      const t = j.transfer || {};
      const state = t.state, frm = t.from;
      const dead = (j.control || {}).desired === "deleted";
      if (frm === machine_id && SEND.includes(state) && !dead) out.send.push(j);
      if (t.to === machine_id && RECV.includes(state) && !dead) out.recv.push(j);
      if (frm === machine_id && ENDED.includes(state) && t.drive_id && !t.pkg_deleted && !t.pkg_gave_up) out.package.push(j);
      if (frm === machine_id && state === TR.DONE && !t.src_purged) out.cleanup.push(j);
      for (const pk of (j.transfer_old_pkgs || [])) {
        if (pk.from === machine_id && pk.drive_id) out.old_pkgs.push([j._id, pk]);
      }
    }
    return out;
  },

  async pull_old_pkg(db, { job_id, drive_id }) {
    const r = await db.collection("jobs").updateOne({ _id: job_id }, { $pull: { transfer_old_pkgs: { drive_id } } });
    return r.modifiedCount;
  },

  async claim_transfer(db, { job_id, from_states, to_state, machine_id }) {
    return db.collection("jobs").findOneAndUpdate(
      { _id: job_id, "transfer.state": { $in: from_states } },
      { $set: { "transfer.state": to_state, "transfer.by": machine_id }, $currentDate: { updated_at: true, "transfer.updated_at": true } },
      { returnDocument: "after" }
    );
  },

  async set_transfer(db, { job_id, fields }) {
    const set = {};
    for (const k of Object.keys(fields || {})) set[`transfer.${k}`] = fields[k];
    const r = await db.collection("jobs").updateOne({ _id: job_id }, { $set: set, $currentDate: { "transfer.updated_at": true } });
    return r.modifiedCount;
  },

  async advance_transfer(db, { job_id, expect, to_state, fields }) {
    const set = {};
    for (const k of Object.keys(fields || {})) set[`transfer.${k}`] = fields[k];
    set["transfer.state"] = to_state;
    const r = await db.collection("jobs").updateOne(
      { _id: job_id, "transfer.state": expect },
      { $set: set, $currentDate: { "transfer.updated_at": true } }
    );
    return r.matchedCount > 0;
  },

  async fail_transfer(db, { job_id, reason, back_to = null, max_attempts = 5 }) {
    back_to = back_to || TR.REQUESTED;
    const j = (await db.collection("jobs").findOne({ _id: job_id }, { projection: { transfer: 1 } })) || {};
    const att = (((j.transfer || {}).attempts) || 0) + 1;
    const state = att < max_attempts ? back_to : TR.FAILED;
    await db.collection("jobs").updateOne({ _id: job_id }, {
      $set: { "transfer.state": state, "transfer.attempts": att, "transfer.error": String(reason).slice(0, 300) },
      $currentDate: { "transfer.updated_at": true },
    });
    return state;
  },

  async finish_transfer(db, { job_id, new_owner, remap }) {
    const j = (await db.collection("jobs").findOne({ _id: job_id }, { projection: { stages: 1 } })) || {};
    const upd = { ...(remap || {}) };
    upd.owner_machine = new_owner;
    upd["devices.pipeline"] = new_owner;
    upd["transfer.state"] = TR.DONE;
    upd["transfer.error"] = null;
    for (const lane of Object.keys(j.stages || {})) upd[`stages.${lane}.lease`] = null;
    const r = await db.collection("jobs").updateOne(
      { _id: job_id, "transfer.state": TR.DOWNLOADING },
      {
        $set: upd,
        $currentDate: { updated_at: true, "transfer.done_at": true },
        $push: pushEvent({ stage: "transfer", to: TR.DONE, by: new_owner }),
      }
    );
    return r.modifiedCount;
  },
});
