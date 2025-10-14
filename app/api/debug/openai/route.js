// app/api/debug/openai/route.js
import OpenAI from "openai";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
    const r = await client.responses.create({
      model,
      input: [{ role: "user", content: "ping" }],
      max_output_tokens: 1,
    });
    return new Response(JSON.stringify({
      ok: true,
      model,
      text: r.output_text,
    }), { status: 200, headers: { "content-type": "application/json" }});
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: String(e?.message || e),
    }), { status: 500, headers: { "content-type": "application/json" }});
  }
}
