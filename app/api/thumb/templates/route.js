import crypto from "crypto";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/mongo";
import { requireUser } from "../../../../lib/gate";
import { DriveError, ensureFolder, makePublicReader, thumbUrl, uploadFile } from "../../../../lib/gdrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
// Vercel cắt body ở 4,5 MB; trình duyệt đã tự thu nhỏ ảnh trước khi gửi.
const MAX_BYTES = 4 * 1024 * 1024;

const shape = (t) => ({
  id: t._id, name: t.name, drive_id: t.drive_id, img: thumbUrl(t.drive_id, 480),
  w: t.w || null, h: t.h || null, bytes: t.bytes || 0, mime: t.mime,
  enabled: t.enabled !== false, uses: t.uses || 0, created_at: t.created_at,
});

// GET — thư viện mẫu chữ (mới nhất trước).
export async function GET() {
  const db = await getDb();
  const rows = await db.collection("thumb_templates").find({}).sort({ created_at: -1 }).toArray();
  return NextResponse.json({ items: rows.map(shape) }, { headers: { "cache-control": "no-store" } });
}

// POST (form-data: file, name, w, h) — upload lên Drive trung tâm rồi lưu vào thư viện.
export async function POST(req) {
  const gate = requireUser(req);
  if (gate) return gate;
  let form;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "form không hợp lệ" }, { status: 400 }); }
  const file = form.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "thiếu file ảnh" }, { status: 400 });
  const ext = TYPES[file.type];
  if (!ext) return NextResponse.json({ error: "chỉ nhận PNG / JPEG / WEBP" }, { status: 415 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "ảnh quá 4 MB" }, { status: 413 });
  const name = String(form.get("name") || file.name || "mẫu chữ").trim().slice(0, 80) || "mẫu chữ";
  const db = await getDb();
  try {
    const parent = await ensureFolder(db, "templates");
    const id = crypto.randomUUID().replace(/-/g, "");
    const buffer = Buffer.from(await file.arrayBuffer());
    const driveId = await uploadFile(db, { name: `${id}.${ext}`, mime: file.type, buffer, parent });
    await makePublicReader(db, driveId);
    const doc = {
      _id: id, name, drive_id: driveId, mime: file.type, bytes: buffer.length,
      w: Number(form.get("w")) || null, h: Number(form.get("h")) || null,
      enabled: true, uses: 0, created_at: new Date(),
    };
    await db.collection("thumb_templates").insertOne(doc);
    return NextResponse.json({ ok: true, item: shape(doc) });
  } catch (e) {
    const status = e instanceof DriveError ? e.status : 500;
    return NextResponse.json({ error: String(e.message || e) }, { status });
  }
}
