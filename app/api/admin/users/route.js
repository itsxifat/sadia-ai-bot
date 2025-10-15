export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { usersCol } from "../../../lib/mongo.js";

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";

async function fbSend(body){
  if (!PAGE_TOKEN) return false;
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  return res.ok;
}
async function sendText(psid, text){
  return fbSend({ recipient:{ id: psid }, message:{ text: String(text).slice(0,1200) } });
}

export async function GET(req) {
  const url = new URL(req.url);
  const search = (url.searchParams.get("q") || "").trim();
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "20"));
  const skip = (page - 1) * limit;

  const col = await usersCol();
  const q = {};
  if (search) {
    q.$or = [
      { psid: search },
      { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }
    ];
  }

  const total = await col.countDocuments(q);
  const items = await col.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit).toArray();

  const res = Response.json({ page, limit, total, items });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function POST(req) {
  try {
    const { psid, verified, vip } = await req.json();
    if (!psid) return new Response("Bad Request", { status: 400 });

    const col = await usersCol();
    const cur = await col.findOne({ psid });

    const patch = { updatedAt: Date.now() };
    let notify = null;

    // verified toggle
    if (typeof verified === "boolean") {
      patch.verified = verified;
      if (verified) {
        // turning ON: reset daily window
        patch.dailyCount = 0;
        patch.dailyAt = null;
        if (!cur?.verified) notify = "You're verified now! 🎉 Daily 100 chat unlocked (auto-reset each day).";
      } else {
        // turning OFF: keep counters as-is (they’ll be ignored by the webhook anyway)
        if (cur?.verified) notify = "Verification removed. You’re back on the free tier.";
      }
    }

    // vip toggle
    if (typeof vip === "boolean") {
      patch.vip = vip;
      if (vip) notify = "VIP enabled—unlimited access. 🚀";
      else if (!notify) notify = "VIP removed. Standard limits apply.";
    }

    await col.updateOne({ psid }, { $set: patch }, { upsert: true });
    const updated = await col.findOne({ psid });

    if (notify) await sendText(psid, notify);

    const res = Response.json({ ok: true, user: updated });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    console.error("[admin/users POST]", e);
    return new Response("Bad Request", { status: 400 });
  }
}
