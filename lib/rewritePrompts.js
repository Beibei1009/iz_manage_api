// Quản lý prompt rewrite + danh sách ngôn ngữ trong Atlas.
// Collections: rewrite_prompts (mỗi chế độ 1 doc) · rewrite_languages (mỗi ngôn ngữ 1 doc).
// Tự SEED từ default nếu rỗng → DB luôn có sẵn 2 chế độ + 5 ngôn ngữ.
import { getDb } from "./mongo";
import { DEFAULT_MODES, DEFAULT_LANGS, ALLOWED_PLACEHOLDERS } from "./rewriteDefaults";

const HISTORY_MAX = 10;

// ── Validate template: phải format được bằng Python .format với đúng bộ placeholder ──
// Trả null nếu OK, hoặc chuỗi lỗi.
export function validateTemplate(t) {
  t = String(t || "");
  if (!t.trim()) return "Template rỗng.";
  for (const need of ["{target_lang}", "{stt_list}", "{subtitles_data}"]) {
    if (!t.includes(need)) return `Thiếu placeholder bắt buộc ${need}.`;
  }
  if (!t.includes("Subtitle Rows to Process:")) {
    return "Thiếu marker 'Subtitle Rows to Process:' (nơi chèn dữ liệu dòng).";
  }
  // placeholder lạ / dấu { } literal chưa nhân đôi → Python .format sẽ vỡ
  let s = t.replace(/\{\{|\}\}/g, "");
  for (const k of ALLOWED_PLACEHOLDERS) s = s.split(`{${k}}`).join("");
  if (s.includes("{") || s.includes("}")) {
    return "Còn dấu { } không hợp lệ. Chỉ được dùng: " +
      ALLOWED_PLACEHOLDERS.map((k) => `{${k}}`).join(", ") +
      " · dấu ngoặc nhọn literal phải viết {{ }}.";
  }
  return null;
}

async function seedIfEmpty(db) {
  const [nm, nl] = await Promise.all([
    db.collection("rewrite_prompts").estimatedDocumentCount(),
    db.collection("rewrite_languages").estimatedDocumentCount(),
  ]);
  if (nm === 0) {
    await db.collection("rewrite_prompts").insertMany(
      DEFAULT_MODES.map((m) => ({ _id: m.key, label: m.label, template: m.template,
        enabled: m.enabled, order: m.order, updated_at: new Date(), history: [] })));
  }
  if (nl === 0) {
    await db.collection("rewrite_languages").insertMany(
      DEFAULT_LANGS.map((l) => ({ _id: l.key, label: l.label, value: l.value,
        enabled: l.enabled, order: l.order })));
  }
}

export async function getRewriteConfig() {
  const db = await getDb();
  await seedIfEmpty(db);
  const [modes, langs] = await Promise.all([
    db.collection("rewrite_prompts").find({}).sort({ order: 1, _id: 1 }).toArray(),
    db.collection("rewrite_languages").find({}).sort({ order: 1, _id: 1 }).toArray(),
  ]);
  return {
    modes: modes.map((m) => ({ key: m._id, label: m.label || m._id, template: m.template || "",
      enabled: m.enabled !== false, order: m.order || 0,
      updated_at: m.updated_at || null, history: (m.history || []).length })),
    langs: langs.map((l) => ({ key: l._id, label: l.label || l._id, value: l.value || l._id,
      enabled: l.enabled !== false, order: l.order || 0 })),
    allowed_placeholders: ALLOWED_PLACEHOLDERS,
  };
}

// Prompt HỢP LỆ của 1 chế độ (để runner/operator lấy). Trả null nếu không có/không bật.
export async function getModeTemplate(key) {
  const db = await getDb();
  await seedIfEmpty(db);
  const m = await db.collection("rewrite_prompts").findOne({ _id: key });
  if (!m || m.enabled === false) return null;
  return m.template || null;
}

export async function upsertMode({ key, label, template, enabled }) {
  key = String(key || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  if (!key) return { error: "Thiếu key chế độ (chỉ a-z 0-9 _)." };
  const err = validateTemplate(template);
  if (err) return { error: err };
  const db = await getDb();
  await seedIfEmpty(db);
  const cur = await db.collection("rewrite_prompts").findOne({ _id: key });
  const history = (cur?.history || []);
  // lưu bản cũ vào history trước khi ghi đè (để rollback)
  if (cur && cur.template && cur.template !== template) {
    history.unshift({ template: cur.template, label: cur.label, at: cur.updated_at || new Date() });
  }
  await db.collection("rewrite_prompts").updateOne(
    { _id: key },
    { $set: { label: String(label || key), template: String(template),
              enabled: enabled !== false, updated_at: new Date(),
              history: history.slice(0, HISTORY_MAX),
              order: cur?.order ?? 999 } },
    { upsert: true });
  return { ok: true, key };
}

export async function deleteMode(key) {
  const db = await getDb();
  await db.collection("rewrite_prompts").deleteOne({ _id: key });
  return { ok: true };
}

// Rollback về bản history thứ idx (0 = mới nhất trong history).
export async function rollbackMode(key, idx = 0) {
  const db = await getDb();
  const cur = await db.collection("rewrite_prompts").findOne({ _id: key });
  if (!cur || !(cur.history || [])[idx]) return { error: "Không có bản lịch sử để khôi phục." };
  const h = cur.history[idx];
  const rest = cur.history.slice();
  rest.splice(idx, 1);
  // đẩy bản hiện tại vào history
  rest.unshift({ template: cur.template, label: cur.label, at: cur.updated_at || new Date() });
  await db.collection("rewrite_prompts").updateOne(
    { _id: key },
    { $set: { template: h.template, updated_at: new Date(), history: rest.slice(0, HISTORY_MAX) } });
  return { ok: true };
}

export async function getModeHistory(key) {
  const db = await getDb();
  const m = await db.collection("rewrite_prompts").findOne({ _id: key });
  return (m?.history || []).map((h, i) => ({ idx: i, at: h.at || null,
    preview: String(h.template || "").slice(0, 200) }));
}

export async function upsertLang({ key, label, value, enabled }) {
  key = String(key || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  value = String(value || "").trim();
  if (!key || !value) return { error: "Cần key (a-z0-9_) và value (tên ngôn ngữ cho AI, vd Korean)." };
  const db = await getDb();
  await seedIfEmpty(db);
  const cur = await db.collection("rewrite_languages").findOne({ _id: key });
  await db.collection("rewrite_languages").updateOne(
    { _id: key },
    { $set: { label: String(label || value), value, enabled: enabled !== false,
              order: cur?.order ?? 999 } },
    { upsert: true });
  return { ok: true, key };
}

export async function deleteLang(key) {
  const db = await getDb();
  await db.collection("rewrite_languages").deleteOne({ _id: key });
  return { ok: true };
}
