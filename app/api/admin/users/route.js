import { usersCol } from "../../../../lib/mongo.js";

export async function GET(req) {
  const url = new URL(req.url);
  const search = (url.searchParams.get("q") || "").trim();
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "20"));
  const skip = (page - 1) * limit;

  const col = await usersCol();
  const q = {};
  if (search) {
    // naive search across psid/name
    q.$or = [
      { psid: search },
      { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }
    ];
  }

  const total = await col.countDocuments(q);
  const items = await col.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit).toArray();
  return Response.json({ page, limit, total, items });
}

export async function POST(req) {
  try {
    const { psid, verified } = await req.json();
    if (!psid || typeof verified !== "boolean") return new Response("Bad Request", { status: 400 });
    const col = await usersCol();
    await col.updateOne({ psid }, { $set: { verified, updatedAt: Date.now() } }, { upsert: true });
    return Response.json({ ok: true });
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
}
