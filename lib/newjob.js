// Mirror core/job.py:new_job + initial_stages (giữ khớp Atlas validator).
export function initialStages() {
  const s = (status) => ({ status, attempts: 0 });
  return {
    download: s("pending"), rewrite: s("pending"), review: s("not_ready"),
    tts: s("blocked"), cut: s("blocked"), metadata: s("blocked"),
    capcut: s("blocked"), convert: s("pending"), publish: s("pending"),
  };
}

export function newJob(jobId, url, ownerMachine, queue = "default", priority = 5, ttsTarget = null) {
  return {
    _id: jobId, owner_machine: ownerMachine, queue, priority, tts_target: ttsTarget,
    // local.jobs_root (folder lưu file trên máy operator) CỐ Ý để null: web không biết
    // folder của máy đó. Operator tự đóng dấu khi worker khởi động và ngay trước mỗi lần
    // đổi folder (core/repo.py :: Repo.pin_jobs_root) → job vẫn luôn tìm đúng chỗ file.
    local: { jobs_root: null },
    note: "",                       // ghi chú user (sửa ở Operator hoặc trên web này)
    devices: { pipeline: ownerMachine, vps: ttsTarget },
    source: { url, video_id: null, title_original: null, description_original: null, thumbnail_link: null },
    rewrite: { srt_src: null, srt_rewritten: null, edited_text: null, approved: false, approved_by: null, approved_at: null },
    stages: initialStages(),
    counts: { srt_segments: null, audio: null, clips: null },
    tts: { drive_in: null, drive_out: null, md5: null, size: null, expected_audio_count: null },
    metadata_options: { titles: [], hooks: [], descriptions: [], chosen_title_idx: null, chosen_desc_idx: null },
    artifacts: {},
    final: { video_link: null, published_at: null },
    control: { desired: "run", effective: "running", restart: null, requested_by: "web:manager", acked_by: null, reason: null },
    waiting_on: "none", next_action: "none", overall_phase: "ingesting", health: "ok",
    lease: null, cleanup: { status: "none" }, events: [],
  };
}

// MIRROR iz_pipeline/core/status.py :: TTS_BUCKETS — sửa 1 bên phải sửa cả bên kia.
// Chia làn tts theo "ai phải làm tiếp" để operator/web/listener nói cùng ngôn ngữ.
export const TTS_BUCKETS = {
  incoming: ["uploaded_to_drive", "claimed_by_vps", "vps_downloading", "vps_received"],
  wait_click: ["waiting_human_tts"],   // ← hàng đợi thật: CHỜ NGƯỜI bấm chạy MiniMax
  running: ["tts_running"],
  returning: ["tts_done", "audio_packing", "audio_uploading"],
};
export const TTS_BUCKET_OF = Object.fromEntries(
  Object.entries(TTS_BUCKETS).flatMap(([b, ss]) => ss.map((s) => [s, b])));

export const ACTION_MAP = {
  approve_review: ["review", "approved"],
  reject_review: ["review", "rejected"],
  capcut_importing: ["capcut", "importing"],
  capcut_running: ["capcut", "auto_capcut_running"],
  capcut_exporting: ["capcut", "exporting"],
  capcut_exported: ["capcut", "exported"],
  tts_click: ["tts", "tts_running"],
};
