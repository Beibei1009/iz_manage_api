// MIRROR core/keypool.py + core/gemini_models.py — sửa 1 bên phải sửa cả bên kia.
// Web chỉ ĐỌC/SỬA pool; việc chọn key lúc chạy do phía Python làm.

export const TIERS = ["free", "pro"];

// rank 1 = tốt nhất. Hạn mức free lấy từ trang Rate Limit của AI Studio (free tier).
// Hạn mức pro là mức khởi tạo — sửa được ngay trên trang này (lưu vào gemini_config).
export const CATALOG = [
  { id: "gemini-3.6-flash", rank: 5, label: "Flash 3.6",
    free: { rpm: 5, tpm: 250000, rpd: 20 }, pro: { rpm: 150, tpm: 2000000, rpd: 10000 } },
  { id: "gemini-3.5-flash", rank: 6, label: "Flash 3.5",
    free: { rpm: 5, tpm: 250000, rpd: 20 }, pro: { rpm: 150, tpm: 2000000, rpd: 10000 } },
  { id: "gemini-3-flash-preview", rank: 7, label: "Flash 3 (preview)",
    free: { rpm: 5, tpm: 250000, rpd: 20 }, pro: { rpm: 150, tpm: 2000000, rpd: 10000 } },
  { id: "gemini-3.5-flash-lite", rank: 2, label: "Flash Lite 3.5",
    free: { rpm: 15, tpm: 250000, rpd: 500 }, pro: { rpm: 300, tpm: 2000000, rpd: 20000 } },
  { id: "gemini-3.1-flash-lite", rank: 3, label: "Flash Lite 3.1",
    free: { rpm: 15, tpm: 250000, rpd: 500 }, pro: { rpm: 300, tpm: 2000000, rpd: 20000 } },
  { id: "gemini-3.1-flash-lite-preview", rank: 1, label: "Flash Lite 3.1 (preview)",
    free: { rpm: 15, tpm: 250000, rpd: 500 }, pro: { rpm: 300, tpm: 2000000, rpd: 20000 } },
  { id: "gemini-2.5-flash", rank: 8, label: "Flash 2.5",
    free: { rpm: 5, tpm: 250000, rpd: 20 }, pro: { rpm: 150, tpm: 2000000, rpd: 10000 } },
  { id: "gemini-2.5-flash-lite", rank: 4, label: "Flash Lite 2.5",
    free: { rpm: 10, tpm: 250000, rpd: 20 }, pro: { rpm: 300, tpm: 2000000, rpd: 20000 } },
];

// Model được dùng theo loại tài khoản (free ít để không dàn mỏng lượt, pro nhiều).
export const DEFAULT_ALLOW = {
  free: ["gemini-3.1-flash-lite-preview", "gemini-3.5-flash-lite", "gemini-3.6-flash"],
  pro: CATALOG.map((m) => m.id),
};
export function allowedIds(tier, allow = {}) {
  const ids = (allow?.[tier]?.length ? allow[tier] : DEFAULT_ALLOW[tier] || [])
    .filter((i) => CATALOG.some((m) => m.id === i));
  return ids.sort((a, b) => BY_ID_RANK[a] - BY_ID_RANK[b]);
}

export const ORDERED = [...CATALOG].sort((a, b) => a.rank - b.rank);
const BY_ID = Object.fromEntries(CATALOG.map((m) => [m.id, m]));
const BY_ID_RANK = Object.fromEntries(CATALOG.map((m) => [m.id, m.rank]));

/** Ngày theo giờ VN — phải khớp core/keypool.py để web và worker cùng thấy 1 "hôm nay". */
export function todayVN(d = new Date()) {
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Hạn mức đã áp override (lưu dạng MẢNG vì model id có dấu chấm — Mongo hiểu dấu
 *  chấm trong đường dẫn là lồng cấp). */
export function limitsOf(modelId, tier, overrides = []) {
  const base = { ...(BY_ID[modelId]?.[tier] || { rpm: 5, tpm: 0, rpd: 20 }) };
  const ov = overrides.find((o) => o.tier === tier && o.model === modelId);
  if (ov) {
    for (const k of ["rpm", "tpm", "rpd"]) {
      if (ov[k] !== undefined && ov[k] !== null) base[k] = Number(ov[k]);
    }
  }
  return base;
}

export function maskKey(k = "") {
  return k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : "…";
}
