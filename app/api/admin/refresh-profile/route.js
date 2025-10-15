export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { usersCol } from "../../../lib/mongo.js";

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";

async function fetchMessengerProfile(psid){
  const fields = "first_name,last_name,profile_pic,locale";
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(psid)}?fields=${fields}&access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const r = await fetch(url, { cache:"no-store" });
  if (!r.ok) return null;
  const j = await r.json().catch(()=> null);
  if (!j) return null;
  return {
    name: [j.first_name, j.last_name].filter(Boolean).join(" ") || null,
    picture: j.profile_pic || null,
    locale: j.locale || null,
    __profileError: false,
  };
}

export async function POST(req){
  try{
    const { psid } = await req.json();
    if (!psid) return new Response("Bad Request", { status: 400 });
    const col = await usersCol();
    const prof = await fetchMessengerProfile(psid);
    if (!prof) return Response.json({ ok:false, reason:"fetch-failed" });
    await col.updateOne({ psid }, { $set: { ...prof, updatedAt: Date.now() } }, { upsert: true });
    return Response.json({ ok:true });
  }catch(e){
    console.error("[refresh-profile]", e);
    return new Response("Bad Request", { status: 400 });
  }
}
