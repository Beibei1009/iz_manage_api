import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/mongo";
import { isAuthed, requireUser } from "../../../lib/gate";
import { ORDERED, TIERS, allowedIds, limitsOf, maskKey, todayVN } from "../../../lib/keypool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Danh sách key + số lần đã gọi HÔM NAY của từng model (đối chiếu RPD).
 *  PHẢI ĐĂNG NHẬP mới đọc được: đây là danh sách API key và hạn mức của cả hệ —
 *  không có lý do gì để người lạ mở URL là thấy. */
export async function GET(req) {
  if (!isAuthed(req)) {
    return NextResponse.json({ authed: false, error: "Chưa đăng nhập" },
      { status: 401, headers: { "cache-control": "no-store" } });
  }
  const db = await getDb();
  const day = todayVN();
  const [keys, usage, cfg] = await Promise.all([
    db.collection("gemini_keys").find({}).sort({ created_at: 1 }).toArray(),
    db.collection("gemini_usage").find({ day }).toArray(),
    db.collection("gemini_config").findOne({ _id: "limits" }),
  ]);
  const overrides = cfg?.overrides || [];
  const allow = cfg?.allow || {};
  const byKeyModel = {};
  for (const u of usage) byKeyModel[`${u.key_id}|${u.model}`] = u;

  const now = Date.now() / 1000;
  const rows = keys.map((k) => {
    const id = String(k._id);
    const tier = k.tier || "free";
    const noModels = k.no_models || [];
    const models = allowedIds(tier, allow).map((mid) => {
      const m = ORDERED.find((x) => x.id === mid);
      const u = byKeyModel[`${id}|${mid}`] || {};
      const lim = limitsOf(mid, tier, overrides);
      return {
        model: mid, label: m.label, rank: m.rank, unavailable: noModels.includes(mid),
        rpd: u.rpd || 0, rpd_limit: lim.rpd, rpm_limit: lim.rpm,
        rpd_exhausted: !!u.rpd_exhausted, denied: !!u.denied,
        cooling_sec: Math.max(0, Math.round((u.blocked_until || 0) - now)),
      };
    });
    return {
      id, name: k.name, tier, enabled: k.enabled !== false,
      status: k.status || "ok", note: k.note || "",
      key_masked: maskKey(k.key || ""), no_models: noModels,
      check_result: k.check_result || null, check_message: k.check_message || "",
      used_today: models.reduce((s, m) => s + m.rpd, 0),
      models,
    };
  });

  // còn bao nhiêu lượt của từng model trên toàn pool → biết sắp hết để nạp key
  const left = {};
  for (const m of ORDERED) {
    left[m.id] = rows
      .filter((r) => r.enabled && r.status !== "denied")
      .reduce((s, r) => {
        const mm = r.models.find((x) => x.model === m.id);
        if (!mm || mm.unavailable || mm.rpd_exhausted || mm.denied) return s;
        return s + Math.max(0, mm.rpd_limit - mm.rpd);
      }, 0);
  }

  return NextResponse.json({
    day, authed: isAuthed(req), keys: rows,
    stats: {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      denied: rows.filter((r) => r.status === "denied").length,
      left_total: Object.values(left).reduce((a, b) => a + b, 0),
      left_by_model: left,
    },
    allow: Object.fromEntries(TIERS.map((t) => [t, allowedIds(t, allow)])),
    catalog: ORDERED.map((m) => ({ id: m.id, label: m.label, rank: m.rank })),
    limits: Object.fromEntries(TIERS.map((t) => [
      t, ORDERED.map((m) => ({ id: m.id, label: m.label, ...limitsOf(m.id, t, overrides) })),
    ])),
  }, { headers: { "cache-control": "no-store" } });
}

/** Thêm key mới. */
export async function POST(req) {
  const guard = requireUser(req);
  if (guard) return guard;
  const body = await req.json().catch(() => ({}));
  const key = String(body.key || "").trim();
  if (!key) return NextResponse.json({ error: "Thiếu API key" }, { status: 400 });
  const tier = TIERS.includes(body.tier) ? body.tier : "free";
  const db = await getDb();
  if (await db.collection("gemini_keys").findOne({ key })) {
    return NextResponse.json({ error: "Key này đã có trong pool" }, { status: 409 });
  }
  const doc = {
    key, name: String(body.name || "").trim() || `key-${key.slice(-6)}`,
    tier, enabled: true, status: "ok", note: String(body.note || ""),
    created_at: new Date(),
  };
  const r = await db.collection("gemini_keys").insertOne(doc);
  return NextResponse.json({ ok: true, id: String(r.insertedId) });
}

/** Sửa hạn mức của 1 model theo tier (dùng cho tài khoản Pro). */
export async function PATCH(req) {
  const guard = requireUser(req);
  if (guard) return guard;
  const body = await req.json().catch(() => ({}));
  const { tier, model } = body;
  if (!TIERS.includes(tier)) return NextResponse.json({ error: "tier không hợp lệ" }, { status: 400 });
  const db = await getDb();

  // đổi GÓI MODEL của tier (free ít model, pro nhiều)
  if (Array.isArray(body.allow)) {
    const ids = body.allow.filter((i) => ORDERED.some((m) => m.id === i));
    if (!ids.length) return NextResponse.json({ error: "phải chọn ít nhất 1 model" }, { status: 400 });
    await db.collection("gemini_config").updateOne(
      { _id: "limits" }, { $set: { [`allow.${tier}`]: ids } }, { upsert: true });
    return NextResponse.json({ ok: true, allow: ids });
  }

  if (!model) return NextResponse.json({ error: "thiếu model" }, { status: 400 });
  const cfg = await db.collection("gemini_config").findOne({ _id: "limits" });
  const rows = (cfg?.overrides || []).filter((r) => !(r.tier === tier && r.model === model));
  const old = (cfg?.overrides || []).find((r) => r.tier === tier && r.model === model) || {};
  const next = { tier, model };
  for (const k of ["rpm", "tpm", "rpd"]) {
    const v = body[k] === undefined || body[k] === null || body[k] === "" ? old[k] : Number(body[k]);
    if (v !== undefined && v !== null) {
      if (!Number.isFinite(v) || v < 0) {
        return NextResponse.json({ error: `${k} phải là số ≥ 0` }, { status: 400 });
      }
      next[k] = Math.round(v);
    }
  }
  rows.push(next);
  await db.collection("gemini_config").updateOne(
    { _id: "limits" }, { $set: { overrides: rows } }, { upsert: true });
  return NextResponse.json({ ok: true });
}
