// app/api/debug/sadia/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { generateReplyLLM } from "../../../lib/sadia-ai.js";

export async function GET() {
  try {
    const reply = await generateReplyLLM({
      psid: "test-web",
      userText: "hi, amar naam test. ajke kemon jachhe?"
    });
    return new Response(JSON.stringify({
      ok: reply != null, reply
    }), { status: 200, headers: { "content-type": "application/json" }});
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false, error: String(e?.message || e)
    }), { status: 500, headers: { "content-type": "application/json" }});
  }
}
