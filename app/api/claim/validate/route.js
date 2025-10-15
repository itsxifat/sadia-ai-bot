// app/api/claim/validate/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { verifySignature } from "../../../lib/sign.js";

export async function GET(req) {
  const t = new URL(req.url).searchParams.get("t");
  const data = verifySignature(t);

  if (!data?.psid) {
    // tiny debug so you can see it in your server logs
    console.warn("[claim/validate] invalid token (sig or format)");
    return Response.json({ ok:false, error:"Invalid" }, { status:400 });
  }

  // Optional: 24h expiry
  const iat = Number(data.iat || 0);
  if (!Number.isFinite(iat) || (Date.now() - iat) > 24*60*60*1000) {
    console.warn("[claim/validate] expired token");
    return Response.json({ ok:false, error:"Link expired" }, { status:400 });
  }

  return Response.json({ ok:true, psid: String(data.psid) });
}
