// app/api/claim-info/submit/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { usersCol } from "../../../../lib/mongo.js";
import { verifySignature } from "../../../../lib/sign.js";

export async function POST(req) {
  try{
    const { t, name, profileUrl } = await req.json();

    const data = verifySignature(t);
    if (!data?.psid) return Response.json({ ok:false, error:"invalid_token" }, { status:400 });

    const cleanName = String(name||"").trim().slice(0, 80);
    const cleanUrl  = String(profileUrl||"").trim();

    if (!cleanName) return Response.json({ ok:false, error:"name_required" }, { status:400 });
    if (!/^https?:\/\/\S{3,200}$/i.test(cleanUrl)) return Response.json({ ok:false, error:"invalid_url" }, { status:400 });

    const col = await usersCol();
    await col.updateOne(
      { psid: String(data.psid) },
      { $set: { name: cleanName, profileUrl: cleanUrl, updatedAt: Date.now() } },
      { upsert: true }
    );

    return Response.json({ ok:true });
  }catch(e){
    console.error("[claim-info submit] error", e);
    return Response.json({ ok:false, error:"server_error" }, { status:500 });
  }
}
