// Port trung thực từ core/gemini_models.py. Khác 1 điểm: BE stateless nên KHÔNG giữ
// _ALLOW/_OVERRIDES ở module — mọi hàm nhận allow/overrides (đọc từ gemini_config) làm tham số.

export const CATALOG = [
  { id: "gemini-3.1-flash-lite-preview", rank: 1, label: "Flash Lite 3.1 (preview)",
    free: { rpm: 15, tpm: 250000, rpd: 500 }, pro: { rpm: 300, tpm: 2000000, rpd: 20000 } },
  { id: "gemini-3.5-flash-lite", rank: 2, label: "Flash Lite 3.5",
    free: { rpm: 15, tpm: 250000, rpd: 500 }, pro: { rpm: 300, tpm: 2000000, rpd: 20000 } },
  { id: "gemini-3.1-flash-lite", rank: 3, label: "Flash Lite 3.1",
    free: { rpm: 15, tpm: 250000, rpd: 500 }, pro: { rpm: 300, tpm: 2000000, rpd: 20000 } },
  { id: "gemini-2.5-flash-lite", rank: 4, label: "Flash Lite 2.5",
    free: { rpm: 10, tpm: 250000, rpd: 20 }, pro: { rpm: 300, tpm: 2000000, rpd: 20000 } },
  { id: "gemini-3.6-flash", rank: 5, label: "Flash 3.6",
    free: { rpm: 5, tpm: 250000, rpd: 20 }, pro: { rpm: 150, tpm: 2000000, rpd: 10000 } },
  { id: "gemini-3.5-flash", rank: 6, label: "Flash 3.5",
    free: { rpm: 5, tpm: 250000, rpd: 20 }, pro: { rpm: 150, tpm: 2000000, rpd: 10000 } },
  { id: "gemini-3-flash-preview", rank: 7, label: "Flash 3 (preview)",
    free: { rpm: 5, tpm: 250000, rpd: 20 }, pro: { rpm: 150, tpm: 2000000, rpd: 10000 } },
  { id: "gemini-2.5-flash", rank: 8, label: "Flash 2.5",
    free: { rpm: 5, tpm: 250000, rpd: 20 }, pro: { rpm: 150, tpm: 2000000, rpd: 10000 } },
];

export const BY_ID = Object.fromEntries(CATALOG.map((m) => [m.id, m]));
export const TIERS = ["free", "pro"];
export const DEFAULT_ALLOW = {
  free: ["gemini-3.1-flash-lite-preview", "gemini-3.5-flash-lite", "gemini-3.6-flash"],
  pro: CATALOG.map((m) => m.id),
};

export function orderedIds() {
  return [...CATALOG].sort((a, b) => a.rank - b.rank).map((m) => m.id);
}

export function allowedIds(allow, tier = "free") {
  tier = TIERS.includes(tier) ? tier : "free";
  let ids = (allow && allow[tier]) || DEFAULT_ALLOW[tier] || [];
  ids = ids.filter((i) => BY_ID[i]);
  return ids.sort((a, b) => BY_ID[a].rank - BY_ID[b].rank);
}

export function limitsOf(overrides, modelId, tier = "free") {
  tier = TIERS.includes(tier) ? tier : "free";
  const ov = (overrides && overrides[tier] && overrides[tier][modelId]) || null;
  if (ov) {
    const base = { ...((BY_ID[modelId] || {})[tier] || { rpm: 5, tpm: 0, rpd: 20 }) };
    for (const k of ["rpm", "tpm", "rpd"]) if (ov[k] != null) base[k] = parseInt(ov[k], 10);
    return base;
  }
  const m = BY_ID[modelId];
  if (!m) return { rpm: 5, tpm: 0, rpd: 20 };
  return { ...m[tier] };
}

export function labelOf(modelId) {
  return (BY_ID[modelId] || {}).label || modelId;
}

export function asRows(overrides, tier = "free") {
  return [...CATALOG].sort((a, b) => a.rank - b.rank).map((m) => ({
    id: m.id, label: m.label, rank: m.rank, ...limitsOf(overrides, m.id, tier),
  }));
}

// today() theo giờ VN (UTC+7), khớp core/keypool.py::today()
export function todayVN(nowMs = Date.now()) {
  const d = new Date(nowMs + 7 * 3600 * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD của thời điểm đã +7h (dùng UTC getters)
}

// Đọc gemini_config/limits → {overrides, allow} (thay cho load_limits()).
export async function loadLimits(db) {
  let doc;
  try { doc = await db.collection("gemini_config").findOne({ _id: "limits" }); } catch { doc = null; }
  doc = doc || {};
  const overrides = Object.fromEntries(TIERS.map((t) => [t, {}]));
  for (const row of doc.overrides || []) {
    const t = row.tier, mid = row.model;
    if (overrides[t] && mid) {
      overrides[t][mid] = {};
      for (const k of ["rpm", "tpm", "rpd"]) if (row[k] != null) overrides[t][mid][k] = row[k];
    }
  }
  const allowRaw = doc.allow || {};
  const allow = {};
  for (const t of TIERS) if (allowRaw[t]) allow[t] = allowRaw[t];
  return { overrides, allow };
}
