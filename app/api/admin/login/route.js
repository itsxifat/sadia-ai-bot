export async function POST(req) {
  try {
    const { password } = await req.json();
    const ok = password && password === process.env.ADMIN_PASSWORD;
    if (!ok) return new Response("Unauthorized", { status: 401 });

    // Set httpOnly session cookie
    const res = new Response("OK", { status: 200 });
    const isProd = process.env.NODE_ENV === "production";
    res.headers.set(
      "Set-Cookie",
      `admin=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; ${isProd ? "Secure;" : ""}`
    );
    return res;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
}
