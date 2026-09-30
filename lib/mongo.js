import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || "youtubedb";

let cached = global._izMongo;
if (!cached) cached = global._izMongo = { client: null, promise: null };

export async function getDb() {
  if (!uri) throw new Error("MONGODB_URI chưa cấu hình (.env.local)");
  if (!cached.promise) {
    // compressors zlib: nén Atlas→Vercel (payload list job nhẹ hẳn). timeout gọn để
    // function không treo 60s khi Atlas chậm. maxPoolSize nhỏ hợp serverless (mỗi
    // container ít kết nối, tái dùng qua global cache). retry để rớt thoáng qua tự nối.
    // serverSelection 15s (nới từ 8s): container LẠNH phải bắt tay TLS với cả 3 node
    // replica set của Atlas M0 (hay bị throttle) — 8s là quá sát, cold start dễ trượt.
    const client = new MongoClient(uri, {
      compressors: ["zlib"],
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      socketTimeoutMS: 30000,
      maxPoolSize: 10,
      retryReads: true,
      retryWrites: true,
    });
    cached.client = client;
    // QUAN TRỌNG: nếu connect() hỏng mà vẫn GIỮ promise đã reject trong cache thì
    // container đó CHẾT VĨNH VIỄN — mọi lần gọi sau đều `await` lại đúng promise
    // reject cũ (trả lỗi tức thì ~0.4s, không hề thử nối lại). Đây chính là lý do
    // /api/cron/notify-tts 500 liên tục hàng giờ trong khi /api/jobs (container
    // khác, nối được) vẫn chạy ngon. → Reject thì XOÁ cache để lần sau nối lại.
    cached.promise = client.connect().catch((err) => {
      if (cached.client === client) { cached.client = null; cached.promise = null; }
      client.close().catch(() => {});
      throw err;
    });
  }
  await cached.promise;
  return cached.client.db(dbName);
}
