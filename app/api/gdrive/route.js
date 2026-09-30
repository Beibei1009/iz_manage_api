import { NextResponse } from "next/server";
import { getDb } from "../../../lib/mongo";
import { isAuthed, requireUser } from "../../../lib/gate";
import { DRIVE_SCOPE, clientSecret, deleteFile, driveDoc, publicClientId } from "../../../lib/gdrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — trạng thái kết nối. Chưa mở khoá thì KHÔNG trả email (chỉ báo có/không).
export async function GET(req) {
  const db = await getDb();
  const doc = await driveDoc(db);
  const authed = isAuthed(req);
  const orphans = authed ? await db.collection("thumb_orphans").countDocuments({}) : 0;
  return NextResponse.json({
    client_id: publicClientId(),          // để GIS mở popup (công khai)
    has_secret: !!clientSecret(),          // server đổi code được không
    configured: !!publicClientId() && !!clientSecret(),
    connected: !!doc?.refresh_token,
    email: authed ? doc?.email || null : null,
    scope: doc?.scope || null,
    scope_ok: !doc?.scope || String(doc.scope).includes(DRIVE_SCOPE) || String(doc.scope).includes("auth/drive "),
    connected_at: authed ? doc?.connected_at || null : null,
    orphans, authed,
  }, { headers: { "cache-control": "no-store" } });
}

// POST {action:"logout"} — thu hồi token + xoá khỏi DB.
// POST {action:"clean_orphans"} — thử xoá lại các file trước đây xoá hỏng.
export async function POST(req) {
  const gate = requireUser(req);
  if (gate) return gate;
  const db = await getDb();
  const body = await req.json().catch(() => ({}));

  if (body.action === "logout") {
    const doc = await driveDoc(db);
    if (doc?.refresh_token) {
      // thu hồi phía Google (best-effort) — không thu hồi thì token vẫn dùng được nếu lộ
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(doc.refresh_token)}`,
        { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }).catch(() => {});
    }
    await db.collection("settings").deleteOne({ _id: "gdrive" });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "clean_orphans") {
    const rows = await db.collection("thumb_orphans").find({}).limit(200).toArray();
    let deleted = 0, failed = 0;
    for (const o of rows) {
      let res;
      try { res = await deleteFile(db, o._id); } catch (e) { res = { ok: false, reason: String(e.message || e) }; }
      if (res.ok) { deleted++; await db.collection("thumb_orphans").deleteOne({ _id: o._id }); }
      else { failed++; await db.collection("thumb_orphans").updateOne({ _id: o._id }, { $set: { reason: res.reason, at: new Date() } }); }
    }
    return NextResponse.json({ ok: true, deleted, failed });
  }

  return NextResponse.json({ error: "action không hợp lệ" }, { status: 400 });
}
