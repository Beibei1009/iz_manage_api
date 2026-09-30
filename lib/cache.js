// Cache IN-MEMORY TTL cấp module — sống theo container (Fluid Compute giữ ấm → hit cao).
// Không phụ thuộc dịch vụ ngoài. Dùng cho các GET bị POLL dày (jobs/machines/listeners) để
// giảm tải Atlas M0. TTL ngắn (vài giây) nên dữ liệu cũ tối đa vài giây — chấp nhận được với
// bảng vốn poll mỗi 6s. KHÔNG cache view chi tiết / sau khi user thao tác (cần tươi ngay).
const store = new Map(); // key -> { at, ttl, val }

export function cacheGet(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > e.ttl) { store.delete(key); return undefined; }
  return e.val;
}

export function cacheSet(key, val, ttlMs) {
  store.set(key, { at: Date.now(), ttl: ttlMs, val });
  // chặn phình vô hạn (nhiều query khác nhau) — quá ngưỡng thì bỏ mục cũ nhất.
  if (store.size > 500) store.delete(store.keys().next().value);
}

/** memo: trả cache nếu còn hạn, không thì chạy fn rồi cache lại. */
export async function memo(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const val = await fn();
  cacheSet(key, val, ttlMs);
  return val;
}

export function invalidate(prefix) {
  for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
}
