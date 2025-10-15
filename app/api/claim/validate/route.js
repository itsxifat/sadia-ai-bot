// app/api/claim/validate/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { verifySignature } from "../../../lib/sign.js";

export async function GET(req) {
  const t = new URL(req.url).searchParams.get("t");
  const data = verifySignature(t);
  if (!data?.psid) return Response.json({ ok:false, error:"Invalid" }, { status:400 });
  // optional: expire after 24h
  if (Date.now() - (data.iat || 0) > 24*60*60*1000) {
    return Response.json({ ok:false, error:"Link expired" }, { status:400 });
  }
  return Response.json({ ok:true, psid: String(data.psid) });
}
