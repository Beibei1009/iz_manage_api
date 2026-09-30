// Proxy ảnh Drive về CÙNG ORIGIN để canvas không bị "tainted" (mới ghép chữ + xuất ảnh được).
// Ảnh ứng viên là file của app (scope drive.file) đã mở quyền đọc công khai — proxy chỉ đọc, không lộ gì thêm.
import { getDb } from "../../../../lib/mongo";
import { gfetch } from "../../../../lib/gdrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response("thiếu id", { status: 400 });
  try {
    const db = await getDb();
    const r = await gfetch(db, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    if (!r.ok) return new Response("drive lỗi " + r.status, { status: r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    return new Response(buf, {
      headers: {
        "Content-Type": r.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return new Response(String(e?.message || e), { status: 500 });
  }
}
