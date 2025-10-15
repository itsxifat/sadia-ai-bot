export async function POST() {
  const res = new Response("OK", { status: 200 });
  res.headers.set("Set-Cookie", "admin=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax");
  return res;
}
