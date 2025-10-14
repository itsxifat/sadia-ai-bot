// app/api/debug/echo-psid/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  const body = await req.json().catch(()=>({}));
  console.log("[DEBUG echo]", JSON.stringify(body, null, 2));
  return new Response("ok", { status: 200 });
}
