// app/api/debug/models/route.js
import OpenAI from "openai";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const arr = [];
    for await (const m of client.models.list()) {
      arr.push(m.id);
    }
    return new Response(JSON.stringify({ ok: true, models: arr }, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
