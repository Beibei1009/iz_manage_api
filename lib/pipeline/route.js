// Khung chung cho các route nhóm pipeline: nhận POST {op, args}, giải mã args (EJSON),
// gọi handler tương ứng với (db, args), mã hoá kết quả rồi trả JSON.
// Middleware đã chặn x-izp-key nên ở đây không cần kiểm auth lại.
import { getDb } from "../mongo";
import { decode, encode } from "./codec";

export function makeGroup(handlers) {
  return async function POST(req) {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "body JSON không hợp lệ" }, 400);
    }
    const op = body?.op;
    const fn = op && handlers[op];
    if (!fn) return json({ error: `op không hỗ trợ: ${op}` }, 400);
    const args = decode(body?.args ?? {}) || {};
    let db;
    try {
      db = await getDb();
    } catch (e) {
      // Tách riêng lỗi NỐI Atlas: tool hiện đúng "BE không nối được Atlas" thay vì
      // chuỗi Mongo trần ('Server selection timed out…') dễ bị hiểu là mạng máy trạm.
      return json({ error: `BE không nối được Atlas: ${String(e?.message || e)}` }, 503);
    }
    try {
      const result = await fn(db, args);
      return json({ ok: true, result: encode(result === undefined ? null : result) });
    } catch (e) {
      const isMongo = /^Mongo/.test(e?.name || "");
      const msg = String(e?.message || e);
      return json({ error: isMongo ? `Atlas lỗi (${e.name}): ${msg}` : msg }, 500);
    }
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
