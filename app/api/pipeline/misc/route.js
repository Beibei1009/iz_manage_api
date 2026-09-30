import { makeGroup } from "../../../../lib/pipeline/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = makeGroup({
  // Repo: r.db.command("ping")
  async ping(db) {
    await db.command({ ping: 1 });
    return { ok: 1 };
  },
  // Repo: r.db["settings"].find_one({"_id": id})
  async get_setting(db, { id }) {
    return db.collection("settings").findOne({ _id: id });
  },
});
