import { ObjectId } from "mongodb";
import { makeGroup } from "../../../../lib/pipeline/route";
import * as gm from "../../../../lib/pipeline/gmodels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPM_WINDOW = 60;
const RPM_COOLDOWN = 62;
const uid = (keyId, model, day) => `${keyId}|${model}|${day}`;
const oid = (v) => (v instanceof ObjectId ? v : new ObjectId(String(v)));
const mask = (k) => (k && k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : "…");

async function usageRows(db, keyId, tier, day, noModels, overrides, allow) {
  const docs = {};
  for (const d of await db.collection("gemini_usage").find({ key_id: keyId, day }).toArray()) docs[d.model] = d;
  const now = Date.now() / 1000;
  const rows = [];
  for (const mid of gm.allowedIds(allow, tier)) {
    const d = docs[mid] || {};
    const lim = gm.limitsOf(overrides, mid, tier);
    const blocked = parseFloat(d.blocked_until || 0);
    rows.push({
      model: mid, label: gm.labelOf(mid),
      rpd: parseInt(d.rpd || 0, 10), rpd_limit: lim.rpd, rpm_limit: lim.rpm,
      rpd_exhausted: Boolean(d.rpd_exhausted), denied: Boolean(d.denied),
      unavailable: (noModels || []).includes(mid),
      cooling_sec: Math.max(0, Math.floor(blocked - now)),
    });
  }
  return rows;
}

export const POST = makeGroup({
  // ---- hạn mức ----
  // Trả cả overrides lẫn allow để tool set lại gemini_models (cho check_keys dùng gm.*).
  async load_limits(db) { return gm.loadLimits(db); },

  async set_limits(db, { tier, model_id, rpm, tpm, rpd }) {
    if (!gm.TIERS.includes(tier)) throw new Error("tier phải là free hoặc pro");
    if (!model_id) throw new Error("thiếu model");
    const vals = {};
    for (const [k, v] of [["rpm", rpm], ["tpm", tpm], ["rpd", rpd]]) {
      if (v != null && v !== "") { const iv = parseInt(v, 10); if (iv < 0) throw new Error(`${k} không được âm`); vals[k] = iv; }
    }
    if (!Object.keys(vals).length) return 0;
    const cfg = db.collection("gemini_config");
    const doc = (await cfg.findOne({ _id: "limits" })) || {};
    const rows = (doc.overrides || []).filter((r) => !(r.tier === tier && r.model === model_id));
    const old = (doc.overrides || []).find((r) => r.tier === tier && r.model === model_id) || {};
    const merged = { tier, model: model_id };
    for (const k of ["rpm", "tpm", "rpd"]) if (old[k] != null) merged[k] = old[k];
    Object.assign(merged, vals);
    rows.push(merged);
    await cfg.updateOne({ _id: "limits" }, { $set: { overrides: rows } }, { upsert: true });
    return Object.keys(vals).length;
  },

  async reset_limits(db, { tier = null }) {
    const cfg = db.collection("gemini_config");
    if (tier && gm.TIERS.includes(tier)) {
      const doc = (await cfg.findOne({ _id: "limits" })) || {};
      const rows = (doc.overrides || []).filter((r) => r.tier !== tier);
      await cfg.updateOne({ _id: "limits" }, { $set: { overrides: rows } }, { upsert: true });
    } else {
      await cfg.deleteOne({ _id: "limits" });
    }
    return true;
  },

  async set_allow(db, { tier, model_ids }) {
    if (!gm.TIERS.includes(tier)) throw new Error("tier phải là free hoặc pro");
    const ids = (model_ids || []).filter((m) => gm.BY_ID[m]);
    if (!ids.length) throw new Error("phải chọn ít nhất 1 model");
    await db.collection("gemini_config").updateOne({ _id: "limits" }, { $set: { [`allow.${tier}`]: ids } }, { upsert: true });
    return ids;
  },

  async limits_table(db, { tier = "free" }) {
    const { overrides } = await gm.loadLimits(db);
    return gm.asRows(overrides, tier);
  },

  // ---- quản lý key ----
  async add_key(db, { key, name = null, tier = "free", note = "" }) {
    key = (key || "").trim();
    if (!key) throw new Error("key rỗng");
    if (!gm.TIERS.includes(tier)) tier = "free";
    if (await db.collection("gemini_keys").findOne({ key })) throw new Error("key này đã có trong pool");
    const doc = { key, name: (name || "").trim() || `key-${key.slice(-6)}`, tier, enabled: true, status: "ok", note, created_at: new Date() };
    const r = await db.collection("gemini_keys").insertOne(doc);
    return String(r.insertedId);
  },

  async update_key(db, { key_id, fields }) {
    const allowedKeys = ["name", "tier", "enabled", "note", "key", "status"];
    const set = {};
    for (const k of allowedKeys) if (k in (fields || {})) set[k] = fields[k];
    if ("tier" in set && !gm.TIERS.includes(set.tier)) delete set.tier;
    if (!Object.keys(set).length) return 0;
    set.updated_at = new Date();
    const r = await db.collection("gemini_keys").updateOne({ _id: oid(key_id) }, { $set: set });
    return r.modifiedCount;
  },

  async delete_key(db, { key_id }) {
    const o = oid(key_id);
    const doc = await db.collection("gemini_keys").findOne({ _id: o });
    if (doc && doc.key) {
      await db.collection("gemini_config").updateOne({ _id: "removed" }, { $addToSet: { keys: doc.key } }, { upsert: true });
    }
    await db.collection("gemini_usage").deleteMany({ key_id: String(o) });
    const r = await db.collection("gemini_keys").deleteOne({ _id: o });
    return r.deletedCount;
  },

  async set_key_check(db, { key_id, status, check_result, check_message }) {
    // Dùng cho check_keys (gọi Google ở tool, ghi kết quả về DB).
    await db.collection("gemini_keys").updateOne({ _id: oid(key_id) }, {
      $set: { status, checked_at: new Date(), check_result, check_message: String(check_message || "").slice(0, 300) },
    });
    return true;
  },

  async list_keys(db, { with_usage = true, day = null }) {
    day = day || gm.todayVN();
    const { overrides, allow } = await gm.loadLimits(db);
    const out = [];
    for (const k of await db.collection("gemini_keys").find({}).sort({ created_at: 1 }).toArray()) {
      const kid = String(k._id);
      const row = {
        id: kid, name: k.name, tier: k.tier || "free", enabled: k.enabled !== false,
        status: k.status || "ok", note: k.note || "",
        key_masked: mask(k.key || ""), key_tail: (k.key || "").slice(-6),
      };
      if (with_usage) {
        row.models = await usageRows(db, kid, k.tier || "free", day, k.no_models || [], overrides, allow);
        row.used_today = row.models.reduce((s, m) => s + m.rpd, 0);
      }
      out.push(row);
    }
    return out;
  },

  // ---- chọn key để chạy ----
  async plan(db, { limit = 12, day = null, now = null }) {
    day = day || gm.todayVN();
    const nowTs = now || Date.now() / 1000;
    const { overrides, allow } = await gm.loadLimits(db);
    const keys = (await db.collection("gemini_keys").find({ enabled: true }).toArray()).filter((k) => (k.key || "").trim());
    if (!keys.length) return [];
    const kidOf = {};
    for (const k of keys) kidOf[String(k._id)] = k;
    const udocs = {};
    for (const d of await db.collection("gemini_usage").find({ day, key_id: { $in: Object.keys(kidOf) } }).toArray()) {
      udocs[`${d.key_id}|${d.model}`] = d;
    }
    const out = [];
    for (const mid of gm.orderedIds()) {
      const cands = [];
      for (const [kid, k] of Object.entries(kidOf)) {
        if (k.status === "denied") continue;
        if (!gm.allowedIds(allow, k.tier || "free").includes(mid)) continue;
        if ((k.no_models || []).includes(mid)) continue;
        const d = udocs[`${kid}|${mid}`] || {};
        if (d.denied || d.rpd_exhausted) continue;
        if (parseFloat(d.blocked_until || 0) > nowTs) continue;
        const lim = gm.limitsOf(overrides, mid, k.tier || "free");
        const used = parseInt(d.rpd || 0, 10);
        if (used >= lim.rpd) continue;
        const recent = (d.rpm_at || []).filter((t) => nowTs - t < RPM_WINDOW);
        if (recent.length >= lim.rpm) continue;
        cands.push({ used, recent: recent.length, kid, k, mid });
      }
      cands.sort((a, b) => a.used - b.used || a.recent - b.recent);
      for (const c of cands) {
        out.push({ key_id: c.kid, key: c.k.key, model: c.mid, tier: c.k.tier || "free", name: c.k.name, used_today: c.used });
        if (out.length >= limit) return out;
      }
    }
    return out;
  },

  // ---- ghi nhận kết quả ----
  async record(db, { key_id, model, result, day = null, now = null }) {
    day = day || gm.todayVN();
    const nowTs = now || Date.now() / 1000;
    const _id = uid(key_id, model, day);
    const base = { key_id: String(key_id), model, day };
    const usage = db.collection("gemini_usage");
    const keys = db.collection("gemini_keys");
    if (result === "ok") {
      await usage.updateOne({ _id }, {
        $set: { ...base, updated_at: new Date() },
        $inc: { rpd: 1 },
        $push: { rpm_at: { $each: [nowTs], $slice: -60 } },
      }, { upsert: true });
    } else if (result === "rpm") {
      await usage.updateOne({ _id }, { $set: { ...base, blocked_until: nowTs + RPM_COOLDOWN, updated_at: new Date() } }, { upsert: true });
    } else if (result === "rpd") {
      await usage.updateOne({ _id }, { $set: { ...base, rpd_exhausted: true, updated_at: new Date() } }, { upsert: true });
    } else if (result === "notfound") {
      try { await keys.updateOne({ _id: oid(key_id) }, { $addToSet: { no_models: model } }); } catch { /* ignore */ }
    } else if (result === "denied") {
      await usage.updateOne({ _id }, { $set: { ...base, denied: true, updated_at: new Date() } }, { upsert: true });
      try { await keys.updateOne({ _id: oid(key_id) }, { $set: { status: "denied" } }); } catch { /* ignore */ }
    }
    return true;
  },

  async stats(db, { day = null }) {
    day = day || gm.todayVN();
    const { overrides, allow } = await gm.loadLimits(db);
    const keys = await db.collection("gemini_keys").find({}).toArray();
    const perModel = {};
    for (const mid of gm.orderedIds()) {
      let left = 0;
      for (const k of keys) {
        if (k.enabled === false || k.status === "denied") continue;
        if (!gm.allowedIds(allow, k.tier || "free").includes(mid)) continue;
        if ((k.no_models || []).includes(mid)) continue;
        const d = (await db.collection("gemini_usage").findOne({ _id: uid(String(k._id), mid, day) })) || {};
        if (d.rpd_exhausted || d.denied) continue;
        const lim = gm.limitsOf(overrides, mid, k.tier || "free");
        left += Math.max(0, lim.rpd - parseInt(d.rpd || 0, 10));
      }
      perModel[mid] = left;
    }
    return {
      day, keys_total: keys.length,
      keys_enabled: keys.filter((k) => k.enabled !== false).length,
      keys_denied: keys.filter((k) => k.status === "denied").length,
      left_by_model: perModel,
      left_total: Object.values(perModel).reduce((s, n) => s + n, 0),
    };
  },

  async purge_old_usage(db, { keep_days = 14, day = null }) {
    const cutMs = Date.now() - keep_days * 86400 * 1000;
    const cut = gm.todayVN(cutMs);
    const r = await db.collection("gemini_usage").deleteMany({ day: { $lt: cut } });
    return r.deletedCount;
  },

  async import_legacy(db, { keys = [] }) {
    const removedDoc = (await db.collection("gemini_config").findOne({ _id: "removed" })) || {};
    const removed = new Set(removedDoc.keys || []);
    let n = 0;
    const list = (keys || []).filter((x) => (x || "").trim());
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      if (removed.has(k)) continue;
      if (await db.collection("gemini_keys").findOne({ key: k })) continue;
      await db.collection("gemini_keys").insertOne({
        key: k, name: `cũ-${i + 1} (${k.slice(-6)})`, tier: "free", enabled: true,
        status: "ok", note: "tự nạp từ Settings của máy", created_at: new Date(),
      });
      n += 1;
    }
    return n;
  },

  // Raw keys cho check_keys (tool gọi Google). Chỉ lộ qua API_SECRET — tương đương
  // việc tool vốn nhúng atlas_uri (đọc thẳng gemini_keys) như trước.
  async raw_keys(db) {
    const out = [];
    for (const k of await db.collection("gemini_keys").find({}).toArray()) {
      out.push({ id: String(k._id), key: k.key, name: k.name, tier: k.tier || "free" });
    }
    return out;
  },

  async ensure_indexes(db) {
    await db.collection("gemini_keys").createIndex({ key: 1 }, { unique: true });
    await db.collection("gemini_usage").createIndex({ day: 1, key_id: 1 });
    await db.collection("gemini_usage").createIndex({ key_id: 1 });
    return null;
  },
});
