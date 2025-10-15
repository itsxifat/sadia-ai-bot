// app/api/yt/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { ytFetchAndUpload } from "../../lib/yt.js";

export async function POST(req) {
  try {
    const { url } = await req.json();
    if (!url) return Response.json({ ok:false, error:"missing_url" }, { status: 400 });
    const result = await ytFetchAndUpload(url);
    return Response.json({ ok:true, ...result });
  } catch (e) {
    const code = String(e.message || e);
    return Response.json({ ok:false, error:code }, { status: 400 });
  }
}
