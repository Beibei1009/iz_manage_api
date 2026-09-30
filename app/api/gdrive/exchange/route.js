import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/mongo";
import { requireUser } from "../../../../lib/gate";
import { DRIVE_SCOPE, DriveError, exchangeCode } from "../../../../lib/gdrive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST {code} — GIS popup trả về authorization code; đổi lấy refresh token + lưu.
export async function POST(req) {
  const gate = requireUser(req);
  if (gate) return gate;
  const { code } = await req.json().catch(() => ({}));
  if (!code) return NextResponse.json({ error: "thiếu code" }, { status: 400 });
  const db = await getDb();
  try {
    const tok = await exchangeCode(code);
    const scope = tok.scope || DRIVE_SCOPE;
    if (!scope.includes("auth/drive")) return NextResponse.json({ error: "Tài khoản chưa cấp quyền Drive — thử lại và tick quyền Drive" }, { status: 400 });
    if (!tok.refresh_token) {
      // Đã cấp quyền trước đó nên Google không trả refresh token mới → gỡ quyền cũ rồi thử lại.
      return NextResponse.json({
        error: "Google không trả refresh token (tài khoản đã cấp quyền trước). Vào myaccount.google.com/permissions gỡ quyền của app này rồi đăng nhập lại.",
      }, { status: 409 });
    }
    const ab = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)",
      { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const about = await ab.json().catch(() => ({}));
    const email = about?.user?.emailAddress || null;

    const prev = await db.collection("settings").findOne({ _id: "gdrive" }, { projection: { email: 1, folders: 1 } });
    const { publicClientId, clientSecret } = await import("../../../../lib/gdrive");
    await db.collection("settings").updateOne({ _id: "gdrive" }, {
      $set: {
        email, name: about?.user?.displayName || null,
        refresh_token: tok.refresh_token, access_token: tok.access_token,
        access_expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000),
        client_id: publicClientId(), client_secret: clientSecret(),
        token_uri: "https://oauth2.googleapis.com/token", scope,
        // đổi tài khoản → id thư mục cũ vô nghĩa (Drive khác)
        folders: prev?.email && prev.email === email ? prev.folders || {} : {},
        connected_at: new Date(), updated_at: new Date(),
      },
    }, { upsert: true });
    return NextResponse.json({ ok: true, email });
  } catch (e) {
    const status = e instanceof DriveError ? e.status : 500;
    return NextResponse.json({ error: String(e.message || e) }, { status });
  }
}
