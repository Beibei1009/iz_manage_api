import { getDb } from "../../../lib/mongo";
import { memo } from "../../../lib/cache";

export const dynamic = "force-dynamic";

// CACHE 3s: poll dày; giảm tải Atlas M0.
export async function GET() {
  return Response.json(await memo("listeners", 3000, listenersPayload));
}

const INFLIGHT = ["uploaded_to_drive", "claimed_by_vps", "vps_downloading",
  "vps_received", "waiting_human_tts", "tts_running", "audio_packing", "audio_uploading"];

async function listenersPayload() {
  const db = await getDb();
  const cutoff = new Date(Date.now() - 180 * 1000);
  const vps = await db.collection("machines")
    .find({ role: "vps", last_heartbeat: { $gte: cutoff } }).toArray();
  const out = [];
  for (const m of vps) {
    const pending = await db.collection("jobs").countDocuments({
      tts_target: m._id, "stages.tts.status": { $in: INFLIGHT } });
    out.push({ machine_id: m._id, name: m.name || m._id, status: m.status, pending });
  }
  return out;
}
