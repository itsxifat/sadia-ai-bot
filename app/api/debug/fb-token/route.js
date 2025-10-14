// app/api/debug/fb-token/route.js
export const runtime = "nodejs";
export async function GET() {
  const t = process.env.MESSENGER_PAGE_TOKEN;
  if (!t) return new Response("No PAGE TOKEN", { status: 500 });
  const r = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${t}`);
  const j = await r.text();
  return new Response(j, { status: r.status, headers: { "Content-Type": "application/json" } });
}
