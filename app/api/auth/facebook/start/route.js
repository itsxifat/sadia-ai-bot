// app/api/auth/facebook/start/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { verifySignature } from "../../../../lib/sign.js";

const FB_APP_ID = process.env.FB_APP_ID || "";
const FB_REDIRECT_URI = process.env.FB_REDIRECT_URI || "";

export async function GET(req) {
  const url = new URL(req.url);
  const t = url.searchParams.get("t"); // signed token that contains { psid, iat }
  const data = verifySignature(t);
  if (!data?.psid) {
    return new Response("Invalid link", { status: 400 });
  }

  // Request only scopes you need. Add more after App Review.
  // email is auto-approved; the user_* ones need review for production users.
  const scope = [
    "public_profile",
    "email",
    // the following require App Review for real users:
    "user_birthday",
    "user_hometown",
    "user_location",
  ].join(",");

  const authUrl = new URL("https://www.facebook.com/v24.0/dialog/oauth");
  authUrl.searchParams.set("client_id", FB_APP_ID);
  authUrl.searchParams.set("redirect_uri", FB_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", t); // carry signed PSID

  return Response.redirect(authUrl.toString(), 302);
}
