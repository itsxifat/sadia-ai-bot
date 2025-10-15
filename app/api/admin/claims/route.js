import { usersCol } from "../../../lib/mongo.js";

export async function GET(req) {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "20"));
  const skip = (page - 1) * limit;

  const col = await usersCol();
  const q = { followClaim: "claimed" };
  const total = await col.countDocuments(q);
  const items = await col.find(q).sort({ followClaimAt: -1 }).skip(skip).limit(limit).toArray();

  return Response.json({ page, limit, total, items });
}
