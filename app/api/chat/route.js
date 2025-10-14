// app/api/chat/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { generateReplyLLM } from "../../lib/sadia-ai.js";

const CHAT_API_TOKEN = process.env.CHAT_API_TOKEN || "";
const ALLOW_ORIGIN = process.env.CORS_ORIGIN || "*";

const hits = new Map();
function rateLimit(ip, limit = 10, windowMs = 10_000) {
  const now = Date.now();
  const s = hits.get(ip) || { n: 0, t: now };
  if (now - s.t > windowMs) { s.n = 0; s.t = now; }
  s.n += 1; hits.set(ip, s);
  return s.n <= limit;
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-api-token",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function POST(req) {
  try {
    const headers = { "Access-Control-Allow-Origin": ALLOW_ORIGIN, Vary: "Origin" };

    if (CHAT_API_TOKEN) {
      const token = req.headers.get("x-api-token") || "";
      if (token !== CHAT_API_TOKEN) return json({ error: "Unauthorized" }, 401, headers);
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "ip";
    if (!rateLimit(ip)) return json({ error: "Too many requests" }, 429, headers);

    let body = {};
    try { body = await req.json(); } catch {}
    const userText = String(body?.userText || "").trim();
    const psid = body?.psid ? String(body.psid) : undefined;

    if (!userText) return json({ error: "userText is required" }, 400, headers);

    const reply = await generateReplyLLM({ psid, userText });
    if (reply == null) return json({ reply: "Ekto tech jhamela hocche. Ektu pore abar try kori? 🙂" }, 200, headers);

    return json({ reply }, 200, headers);
  } catch (e) {
    console.error("[CHAT route error]", e);
    return json({ error: "Internal error" }, 500, { "Access-Control-Allow-Origin": ALLOW_ORIGIN });
  }
}
