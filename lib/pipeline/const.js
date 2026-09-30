// Hằng số port TRUNG THỰC từ tool (core/status.py, transfer.py, thumbgen.py).
// Giữ khớp tuyệt đối — mọi thay đổi bên Python phải cập nhật ở đây.

// --- status.py ---------------------------------------------------------------
export const LANES = {
  download: ["pending", "claimed", "downloading", "done", "failed", "waiting_manual"],
  rewrite: ["pending", "rewriting", "done", "failed"],
  review: ["not_ready", "waiting_human", "editing", "approved", "rejected"],
  separate: ["pending", "separating", "done", "failed"],
  assemble: ["pending", "assembling", "done", "failed"],
  tts: [
    "blocked", "pending", "packing", "uploading_to_drive", "uploaded_to_drive",
    "claimed_by_vps", "vps_downloading", "vps_received", "waiting_human_tts",
    "tts_running", "tts_done", "audio_packing", "audio_uploading",
    "audio_uploaded", "local_downloading", "audio_ready", "failed",
  ],
  cut: ["blocked", "pending", "cutting", "done", "failed"],
  metadata: ["blocked", "pending", "generating", "done", "failed"],
  capcut: ["blocked", "ready", "importing", "auto_capcut_running", "exporting", "exported", "redo"],
  convert: ["pending", "converting", "done", "failed"],
  publish: ["pending", "uploading_final", "link_ready", "failed"],
};

export const CONTROL_DESIRED = ["run", "paused", "stopped", "deleted"];

// Nhóm status TTS đang bay (khớp TTS_BUCKETS trong status.py).
export const TTS_BUCKETS_MAP = {
  incoming: ["uploaded_to_drive", "claimed_by_vps", "vps_downloading", "vps_received"],
  wait_click: ["waiting_human_tts"],
  running: ["tts_running"],
  returning: ["tts_done", "audio_packing", "audio_uploading"],
};
export const TTS_BUCKETS = Object.keys(TTS_BUCKETS_MAP); // ["incoming","wait_click","running","returning"]
export const TTS_INFLIGHT = Object.values(TTS_BUCKETS_MAP).flat();
export const TTS_BUCKET_OF = Object.fromEntries(
  Object.entries(TTS_BUCKETS_MAP).flatMap(([b, ss]) => ss.map((s) => [s, b]))
);

// --- transfer.py -------------------------------------------------------------
export const TR = {
  REQUESTED: "requested", PACKING: "packing", UPLOADING: "uploading",
  READY: "ready", DOWNLOADING: "downloading", DONE: "done",
  FAILED: "failed", CANCELLED: "cancelled",
};
export const TR_INFLIGHT = [TR.REQUESTED, TR.PACKING, TR.UPLOADING, TR.READY, TR.DOWNLOADING];
export const TR_STATE_LABEL = {
  [TR.REQUESTED]: "⇄ chờ đóng gói", [TR.PACKING]: "⇄ đang nén",
  [TR.UPLOADING]: "⇄ đang đẩy lên Drive", [TR.READY]: "⇄ chờ máy đích tải",
  [TR.DOWNLOADING]: "⇄ đang tải về", [TR.DONE]: "⇄ đã chuyển",
  [TR.FAILED]: "⇄ chuyển LỖI", [TR.CANCELLED]: "⇄ đã huỷ lệnh chuyển",
};
// drive_key(job_id) — khớp core/transfer.py::drive_key
export function driveKey(jobId) {
  return `transfer/${jobId}.zip`;
}

// --- thumbgen.py -------------------------------------------------------------
export const TG = {
  QUEUED: "queued", GENERATING: "generating", READY: "ready",
  DONE: "done", FAILED: "failed", CANCELLED: "cancelled",
  LEASE_SECONDS: 600, MAX_ATTEMPTS: 5, TEMPLATES: "thumb_templates",
};

// Events cap (repo._EVENTS_CAP)
export const EVENTS_CAP = 50;
