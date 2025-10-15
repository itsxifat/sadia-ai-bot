// app/api/admin/users/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { usersCol } from "../../../lib/mongo.js";

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";
const ROOT_ADMINS = new Set(
  (process.env.ADMIN_PSIDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

async function fbSend(body){
  if (!PAGE_TOKEN) return false;
  const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  return res.ok;
}
async function sendText(psid, text){
  if (!PAGE_TOKEN) return false;
  return fbSend({ recipient: { id: psid }, message: { text: String(text).slice(0,1200) } });
}

export async function GET(req) {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")||50)));
  const q = (url.searchParams.get("q") || "").trim();

  const col = await usersCol();
  const find = q
    ? { $or: [
        { psid:   { $regex: q, $options:"i" } },
        { name:   { $regex: q, $options:"i" } },
        { locale: { $regex: q, $options:"i" } },
      ] }
    : {};

  const base = await col
    .find(find, { projection: { _id:0 } })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();

  // annotate root admins for UI
  const items = base.map(u => ({ ...u, rootAdmin: ROOT_ADMINS.has(u.psid) }));

  return Response.json({ items });
}

export async function POST(req) {
  try{
    const body = await req.json();
    const { psid, verified, vip, banned, isAdmin } = body || {};
    if (!psid) return Response.json({ ok:false, error:"missing_psid" }, { status:400 });

    const col = await usersCol();
    const cur = await col.findOne({ psid }, { projection: { _id:0, isAdmin:1, banned:1 } });

    // protections
    const isRootTarget = ROOT_ADMINS.has(psid);
    if (typeof banned === "boolean") {
      if (banned && (isRootTarget || cur?.isAdmin)) {
        return Response.json({ ok:false, error:"cannot_ban_admin" }, { status:400 });
      }
    }
    if (typeof isAdmin === "boolean") {
      if (!isAdmin && isRootTarget) {
        return Response.json({ ok:false, error:"cannot_demote_root_admin" }, { status:400 });
      }
    }

    const patch = { updatedAt: Date.now() };
    if (typeof verified === "boolean") {
      patch.verified = verified;
      if (verified) { patch.dailyCount = 0; patch.dailyAt = Date.now(); }
    }
    if (typeof vip === "boolean") patch.vip = vip;
    if (typeof banned === "boolean") patch.banned = banned;
    if (typeof isAdmin === "boolean") patch.isAdmin = isAdmin;

    await col.updateOne({ psid }, { $set: patch }, { upsert: true });
    const user = await col.findOne({ psid }, { projection: { _id:0 } });

    // best-effort notifications
    if (typeof verified === "boolean")
      await sendText(psid, verified ? "You’re verified now! 🎉 100 chats/day." : "Verification removed. You still have 10 free replies.");
    if (typeof vip === "boolean")
      await sendText(psid, vip ? "VIP enabled—unlimited chats. ✨" : "VIP removed. Normal limits apply.");
    if (typeof banned === "boolean")
      await sendText(psid, banned ? "Your access is restricted." : "Your access has been restored.");
    if (typeof isAdmin === "boolean")
      await sendText(psid, isAdmin ? "You are now an admin. 🔐" : "Admin privileges removed.");

    return Response.json({ ok:true, user: { ...user, rootAdmin: ROOT_ADMINS.has(psid) } });
  }catch(e){
    console.error("[admin/users POST] error", e);
    return Response.json({ ok:false, error:"server_error" }, { status:500 });
  }
}
