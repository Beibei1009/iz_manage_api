// Google Drive của TÀI KHOẢN TRUNG TÂM — admin đăng nhập ở /keys → ☁ Google Drive.
//
// Mọi ảnh thumbnail (mẫu chữ do web upload, ảnh ứng viên do tool pipeline upload) đều thuộc
// tài khoản này. Lý do: Drive CHỈ cho chủ file xoá hoặc bỏ thùng rác — quyền "anyone with
// link writer" KHÔNG giúp người khác xoá (đo thật: canDelete=false, canTrash=false). Web cần
// xoá các ảnh admin không chọn, nên web phải là chủ của chúng.
//
// Token lưu ở Mongo `settings/gdrive` (kèm client id/secret) để tool pipeline dùng CHUNG
// token này khi upload ảnh — không cần API trung gian. Gọi Drive bằng REST thuần, không kéo
// thêm package googleapis.
import crypto from "crypto";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
// cùng cây thư mục với tool pipeline (engine/gdrive.py :: APP_ROOT)
export const FOLDERS = { root: "IzPipeline", templates: "thumb_templates", thumbnails: "thumbnails" };

export class DriveError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}

/** Ảnh xem được mà không cần đăng nhập (file đã mở quyền đọc công khai). */
export const thumbUrl = (id, w = 640) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${w}`;
export const viewUrl = (id) => `https://drive.google.com/file/d/${id}/view`;

/** Client OAuth loại "Web application". clientId công khai (NEXT_PUBLIC), secret chỉ ở server.
 *  Đăng nhập bằng Google Identity Services (popup code flow) giống Youtube_Check — không dùng
 *  redirect trang, nên KHÔNG cần đăng ký redirect URI, chỉ cần thêm origin vào Authorized
 *  JavaScript origins của client. */
export const publicClientId = () =>
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
export const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || "";
export const hasOauth = () => !!publicClientId() && !!clientSecret();

/** Đổi authorization code (từ GIS popup, redirect_uri='postmessage') lấy refresh token. */
export async function exchangeCode(code) {
  const clientId = publicClientId();
  const secret = clientSecret();
  if (!clientId || !secret) throw new DriveError("Server chưa đặt GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET", 409);
  const r = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: secret,
      redirect_uri: "postmessage", grant_type: "authorization_code",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new DriveError(`Google từ chối đổi mã (${j.error || r.status})`, 400);
  return j; // { access_token, refresh_token?, expires_in, scope }
}

export const driveDoc = (db) => db.collection("settings").findOne({ _id: "gdrive" });

/** Access token còn hạn (tự làm mới bằng refresh token, lưu lại để lần sau khỏi làm mới). */
export async function accessToken(db, { force = false } = {}) {
  const doc = await driveDoc(db);
  if (!doc?.refresh_token) throw new DriveError("Chưa đăng nhập Google Drive — vào /keys → ☁ Google Drive", 409);
  const exp = doc.access_expires_at ? new Date(doc.access_expires_at).getTime() : 0;
  if (!force && doc.access_token && exp - Date.now() > 60_000) return doc.access_token;
  const r = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: doc.client_id, client_secret: doc.client_secret,
      refresh_token: doc.refresh_token, grant_type: "refresh_token",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new DriveError(`Google từ chối làm mới token (${j.error || r.status}) — đăng nhập lại ở /keys`, 409);
  }
  await db.collection("settings").updateOne({ _id: "gdrive" }, {
    $set: { access_token: j.access_token, access_expires_at: new Date(Date.now() + (j.expires_in || 3600) * 1000) },
  });
  return j.access_token;
}

/** fetch có Authorization; gặp 401 thì làm mới token và thử lại đúng 1 lần. */
export async function gfetch(db, url, init = {}) {
  let token = await accessToken(db);
  const go = (t) => fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
  let r = await go(token);
  if (r.status === 401) {
    token = await accessToken(db, { force: true });
    r = await go(token);
  }
  return r;
}

async function findFolder(db, name, parent) {
  const q = `name='${name.replace(/'/g, "\\'")}' and '${parent}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;
  const r = await gfetch(db, `${API}/files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "1" })}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new DriveError(`Drive: không tìm được thư mục ${name} (${j.error?.message || r.status})`);
  return j.files?.[0]?.id || null;
}

async function createFolder(db, name, parent) {
  const r = await gfetch(db, `${API}/files?fields=id`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new DriveError(`Drive: không tạo được thư mục ${name} (${j.error?.message || r.status})`);
  return j.id;
}

async function folderAlive(db, id) {
  if (!id) return false;
  const r = await gfetch(db, `${API}/files/${id}?fields=id,trashed`);
  if (!r.ok) return false;
  const j = await r.json().catch(() => ({}));
  return !!j.id && !j.trashed;
}

/** Thư mục IzPipeline/<sub>, tạo nếu chưa có; nhớ id trong settings/gdrive.folders. */
export async function ensureFolder(db, sub) {
  const doc = await driveDoc(db);
  const cached = doc?.folders || {};
  if (await folderAlive(db, cached[sub])) return cached[sub];
  let root = cached.root;
  if (!(await folderAlive(db, root))) {
    root = (await findFolder(db, FOLDERS.root, "root")) || (await createFolder(db, FOLDERS.root, "root"));
  }
  const id = (await findFolder(db, FOLDERS[sub], root)) || (await createFolder(db, FOLDERS[sub], root));
  await db.collection("settings").updateOne({ _id: "gdrive" }, { $set: { "folders.root": root, [`folders.${sub}`]: id } });
  return id;
}

/** Upload 1 file nhỏ (multipart) → id. */
export async function uploadFile(db, { name, mime, buffer, parent }) {
  const boundary = `izp${crypto.randomBytes(8).toString("hex")}`;
  const meta = JSON.stringify({ name, mimeType: mime, parents: [parent] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await gfetch(db, `${UPLOAD}/files?uploadType=multipart&fields=id,size`, {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new DriveError(`Drive: upload thất bại (${j.error?.message || r.status})`);
  return j.id;
}

/** Ai có link cũng XEM được (để <img> trên web hiển thị). Chỉ đọc — không cho sửa. */
export async function makePublicReader(db, id) {
  const r = await gfetch(db, `${API}/files/${id}/permissions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "anyone", role: "reader" }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new DriveError(`Drive: không mở quyền xem được (${j.error?.message || r.status})`);
  }
}

/** Xoá thật. ok=true nếu đã mất (kể cả vốn không còn). ok=false kèm lý do nếu Drive từ chối —
 *  thường là file KHÔNG thuộc tài khoản này (Drive chỉ cho chủ file xoá). */
export async function deleteFile(db, id) {
  const r = await gfetch(db, `${API}/files/${id}`, { method: "DELETE" });
  if (r.ok || r.status === 404) return { ok: true, status: r.status };
  const j = await r.json().catch(() => ({}));
  return { ok: false, status: r.status, reason: j.error?.errors?.[0]?.reason || j.error?.message || `HTTP ${r.status}` };
}

/** Xoá một loạt; file nào không xoá được thì ghi vào thumb_orphans để dọn lại sau (nút ở /keys). */
export async function dropFiles(db, ids, jid) {
  let deleted = 0, failed = 0;
  for (const id of ids) {
    let res;
    try { res = await deleteFile(db, id); } catch (e) { res = { ok: false, reason: String(e.message || e) }; }
    if (res.ok) { deleted++; continue; }
    failed++;
    await db.collection("thumb_orphans").updateOne({ _id: id },
      { $set: { jid: jid ?? null, reason: res.reason || null, at: new Date() } }, { upsert: true });
  }
  return { deleted, failed };
}
