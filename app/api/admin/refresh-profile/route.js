export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { usersCol } from "../../../../lib/mongo.js";
const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";

export async function POST(req) {
  try{
    const { psid } = await req.json();
    if (!psid) return Response.json({ ok:false, error:"missing_psid" }, { status:400 });
    if (!PAGE_TOKEN) return Response.json({ ok:false, error:"missing_page_token" }, { status:500 });

    const url = new URL(`https://graph.facebook.com/v24.0/${encodeURIComponent(psid)}`);
    url.searchParams.set("fields","first_name,last_name,profile_pic,locale");
    url.searchParams.set("access_token", PAGE_TOKEN);
    const r = await fetch(url, { cache:"no-store" });
    if (!r.ok) { console.warn("[refresh-profile] graph error", r.status, await r.text().catch(()=> "")); return Response.json({ ok:false }, { status:200 }); }
    const g = await r.json();
    const name = [g.first_name, g.last_name].filter(Boolean).join(" ") || null;
    const picture = g.profile_pic || null;
    const locale = g.locale || null;

    const col = await usersCol();
    const patch = { updatedAt: Date.now() };
    if (name) patch.name = name;
    if (picture) patch.picture = picture;
    if (locale) patch.locale = locale;
    await col.updateOne({ psid }, { $set: patch }, { upsert: true });

    const user = await col.findOne({ psid }, { projection: { _id:0 } });
    return Response.json({ ok:true, user });
  }catch(e){
    console.error("[refresh-profile POST] error", e);
    return Response.json({ ok:false, error:"server_error" }, { status:500 });
  }
}
