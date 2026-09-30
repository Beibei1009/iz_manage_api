import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/mongo";
import { requireUser } from "../../../../lib/gate";
import { TIERS } from "../../../../lib/keypool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function oid(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}

/** Sửa 1 key: tên · tier · bật/tắt · ghi chú · thay chuỗi key. */
export async function PATCH(req, { params }) {
  const guard = requireUser(req);
  if (guard) return guard;
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: "id không hợp lệ" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const set = {};
  if (typeof body.name === "string") set.name = body.name.trim();
  if (typeof body.note === "string") set.note = body.note;
  if (typeof body.enabled === "boolean") set.enabled = body.enabled;
  if (TIERS.includes(body.tier)) set.tier = body.tier;
  if (typeof body.key === "string" && body.key.trim()) set.key = body.key.trim();
  // bật lại key đã bị đánh dấu chết = coi như user đã sửa xong bên Google
  if (body.enabled === true || body.reset_status === true) set.status = "ok";
  if (!Object.keys(set).length) {
    return NextResponse.json({ error: "không có gì để sửa" }, { status: 400 });
  }
  set.updated_at = new Date();

  const db = await getDb();
  const r = await db.collection("gemini_keys").updateOne({ _id }, { $set: set });
  if (!r.matchedCount) return NextResponse.json({ error: "không tìm thấy key" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Xoá key + xoá luôn số liệu dùng của nó. */
export async function DELETE(req, { params }) {
  const guard = requireUser(req);
  if (guard) return guard;
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: "id không hợp lệ" }, { status: 400 });
  const db = await getDb();
  await db.collection("gemini_usage").deleteMany({ key_id: String(params.id) });
  const r = await db.collection("gemini_keys").deleteOne({ _id });
  if (!r.deletedCount) return NextResponse.json({ error: "không tìm thấy key" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
