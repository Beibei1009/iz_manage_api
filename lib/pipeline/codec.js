// Codec EJSON tối giản, khớp với core/apibackend.py bên tool Python.
// Chỉ 2 kiểu BSON mà tool dùng cần bảo toàn khi đi qua JSON:
//   datetime  <->  { "$date": <ms since epoch> }
//   ObjectId  <->  { "$oid": "<hex>" }
// Đi 2 chiều: decode (JSON từ tool → giá trị JS/BSON để đưa vào Mongo) và
// encode (kết quả Mongo → JSON an toàn để trả về tool).
import { ObjectId } from "mongodb";

// JSON (từ tool) → giá trị JS: {$date}→Date, {$oid}→ObjectId. Đệ quy.
export function decode(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(decode);
  if (typeof v === "object") {
    if (typeof v.$date === "number") return new Date(v.$date);
    if (typeof v.$oid === "string") return new ObjectId(v.$oid);
    const out = {};
    for (const k of Object.keys(v)) out[k] = decode(v[k]);
    return out;
  }
  return v;
}

// Giá trị Mongo → JSON an toàn cho tool: Date→{$date}, ObjectId→{$oid}. Đệ quy.
export function encode(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return { $date: v.getTime() };
  if (v instanceof ObjectId) return { $oid: v.toString() };
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === "object") {
    // Số Long/Int của driver → number thường (BSON Long có .toNumber)
    if (typeof v.toNumber === "function" && v._bsontype === "Long") return v.toNumber();
    const out = {};
    for (const k of Object.keys(v)) out[k] = encode(v[k]);
    return out;
  }
  return v;
}
