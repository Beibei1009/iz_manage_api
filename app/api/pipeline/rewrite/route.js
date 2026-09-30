import { makeGroup } from "../../../../lib/pipeline/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Port trung thực từ core/repo.py: get_rewrite_modes / get_rewrite_languages / get_mode_template.
export const POST = makeGroup({
  async get_rewrite_modes(db) {
    const out = [];
    const cur = db.collection("rewrite_prompts").find({}).sort({ order: 1, _id: 1 });
    for await (const m of cur) {
      if (m.enabled === false) continue;
      out.push({ key: m._id, label: m.label || m._id, template: m.template || "" });
    }
    return out;
  },

  async get_rewrite_languages(db) {
    const out = [];
    const cur = db.collection("rewrite_languages").find({}).sort({ order: 1, _id: 1 });
    for await (const l of cur) {
      if (l.enabled === false) continue;
      out.push({ label: l.label || l.value || l._id, value: l.value || l._id });
    }
    return out;
  },

  async get_mode_template(db, { key }) {
    const m = await db.collection("rewrite_prompts").findOne({ _id: key });
    if (!m || m.enabled === false) return null;
    return m.template || null;
  },

  // admin/seed_dub_prompt.py — đọc + upsert 1 chế độ rewrite.
  async get_rewrite_prompt(db, { id }) {
    return db.collection("rewrite_prompts").findOne({ _id: id });
  },
  async upsert_rewrite_prompt(db, { id, doc }) {
    // _id đã cố định qua filter → bỏ khỏi $set để tránh lỗi immutable field.
    const set = { ...(doc || {}) };
    delete set._id;
    const r = await db.collection("rewrite_prompts").updateOne({ _id: id }, { $set: set }, { upsert: true });
    return { matched: r.matchedCount, upserted: r.upsertedCount };
  },
});
