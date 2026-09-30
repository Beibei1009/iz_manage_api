import { NextResponse } from "next/server";
import { isAuthed, requireUser } from "../../../lib/gate";
import {
  getRewriteConfig, upsertMode, deleteMode, rollbackMode, getModeHistory,
  upsertLang, deleteLang,
} from "../../../lib/rewritePrompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "cache-control": "no-store" } };

// GET — toàn bộ chế độ (prompt) + ngôn ngữ (cần đăng nhập: template là nội bộ).
export async function GET(req) {
  if (!isAuthed(req)) {
    return NextResponse.json({ authed: false, error: "Chưa đăng nhập" }, { status: 401, ...noStore });
  }
  const cfg = await getRewriteConfig();
  return NextResponse.json({ authed: true, ...cfg }, noStore);
}

// POST — upsert mode/lang · rollback · history (theo body.kind)
export async function POST(req) {
  const guard = requireUser(req);
  if (guard) return guard;
  const b = await req.json().catch(() => ({}));
  const kind = b.kind;
  let r;
  if (kind === "mode") {
    r = await upsertMode({ key: b.key, label: b.label, template: b.template, enabled: b.enabled });
  } else if (kind === "lang") {
    r = await upsertLang({ key: b.key, label: b.label, value: b.value, enabled: b.enabled });
  } else if (kind === "rollback") {
    r = await rollbackMode(b.key, Number(b.idx) || 0);
  } else if (kind === "history") {
    return NextResponse.json({ history: await getModeHistory(b.key) });
  } else {
    return NextResponse.json({ error: "kind không hợp lệ" }, { status: 400 });
  }
  if (r?.error) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, ...r });
}

// DELETE ?kind=mode|lang&key=...
export async function DELETE(req) {
  const guard = requireUser(req);
  if (guard) return guard;
  const kind = req.nextUrl.searchParams.get("kind");
  const key = req.nextUrl.searchParams.get("key");
  if (!key) return NextResponse.json({ error: "thiếu key" }, { status: 400 });
  if (kind === "mode") await deleteMode(key);
  else if (kind === "lang") await deleteLang(key);
  else return NextResponse.json({ error: "kind không hợp lệ" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
