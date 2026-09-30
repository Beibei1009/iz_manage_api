import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/mongo";
import { requireUser } from "../../../../../lib/gate";
import { dropFiles } from "../../../../../lib/gdrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH {name?, enabled?}
export async function PATCH(req, { params }) {
  const gate = requireUser(req);
  if (gate) return gate;
  const b = await req.json().catch(() => ({}));
  const set = {};
  if (typeof b.name === "string" && b.name.trim()) set.name = b.name.trim().slice(0, 80);
  if (typeof b.enabled === "boolean") set.enabled = b.enabled;
  if (!Object.keys(set).length) return NextResponse.json({ error: "không có gì để sửa" }, { status: 400 });
  const db = await getDb();
  const r = await db.collection("thumb_templates").updateOne({ _id: params.id }, { $set: set });
  if (!r.matchedCount) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

// DELETE — xoá khỏi thư viện + xoá file trên Drive. Task đang xếp hàng với mẫu này sẽ được
// tool pipeline báo "Mẫu chữ không còn" thay vì chạy với ảnh hỏng.
export async function DELETE(req, { params }) {
  const gate = requireUser(req);
  if (gate) return gate;
  const db = await getDb();
  const t = await db.collection("thumb_templates").findOne({ _id: params.id });
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });
  const res = t.drive_id ? await dropFiles(db, [t.drive_id], null) : { deleted: 0, failed: 0 };
  await db.collection("thumb_templates").deleteOne({ _id: params.id });
  return NextResponse.json({ ok: true, ...res });
}
