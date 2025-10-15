// app/api/auth/facebook/callback/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import crypto from "crypto";
import { usersCol } from "../../../../lib/mongo.js";
import { verifySignature } from "../../../../lib/sign.js";

const FB_APP_ID       = process.env.FB_APP_ID || "";
const FB_APP_SECRET   = process.env.FB_APP_SECRET || "";
const ENV_REDIRECT    = process.env.FB_REDIRECT_URI || "";
const PAGE_TOKEN      = process.env.MESSENGER_PAGE_TOKEN || "";
const BASE_URL        = (process.env.PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/,"");

function buildRedirectFromReq(req) {
  // Fallback to the actual URL the user hit, to avoid env typos during dev.
  // This MUST still match the URL used in the initial /dialog/oauth call.
  const u = new URL(req.url);
  // Ensure we only keep scheme+host and the callback path:
  return `${u.origin}/api/auth/facebook/callback`;
}

async function fbSend(body){
  if (!PAGE_TOKEN) return false;
  const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    console.warn("[FB SendAPI] error", res.status, t);
  }
  return res.ok;
}
async function sendText(psid, text){
  if (!PAGE_TOKEN) return false;
  return fbSend({ recipient:{ id: psid }, message:{ text: String(text).slice(0,1200) } });
}

export async function GET(req) {
  try {
    // Basic query params from Facebook
    const u = new URL(req.url);
    const code   = u.searchParams.get("code");
    const state  = u.searchParams.get("state");
    const err    = u.searchParams.get("error");
    const errDesc= u.searchParams.get("error_description");

    // Early surface of OAuth user-facing errors
    if (err) {
      console.warn("[FB oauth] user error:", err, errDesc || "");
      return Response.redirect(`${BASE_URL}/claim?error=${encodeURIComponent(err)}&desc=${encodeURIComponent(errDesc||"")}`, 302);
    }
    if (!code) {
      console.warn("[FB oauth] missing code param");
      return Response.redirect(`${BASE_URL}/claim?error=missing_code`, 302);
    }
    if (!state) {
      console.warn("[FB oauth] missing state param");
      return Response.redirect(`${BASE_URL}/claim?error=missing_state`, 302);
    }

    // Verify PSID token we sent as state
    const data = verifySignature(state);
    if (!data?.psid) {
      console.warn("[FB oauth] invalid state signature");
      return Response.redirect(`${BASE_URL}/claim?error=invalid_state`, 302);
    }
    const psid = String(data.psid);

    // Guard envs
    if (!/^\d{5,}$/.test(FB_APP_ID)) {
      console.error("[FB oauth] FB_APP_ID missing/invalid:", FB_APP_ID);
      return Response.redirect(`${BASE_URL}/claim?error=server_misconfigured_app_id`, 302);
    }
    if (!FB_APP_SECRET) {
      console.error("[FB oauth] FB_APP_SECRET missing");
      return Response.redirect(`${BASE_URL}/claim?error=server_misconfigured_secret`, 302);
    }

    // redirect_uri must match the one used to start the flow
    const redirectUri = ENV_REDIRECT || buildRedirectFromReq(req);

    // 1) Exchange code -> access_token
    const tokenUrl = new URL("https://graph.facebook.com/v24.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", FB_APP_ID);
    tokenUrl.searchParams.set("client_secret", FB_APP_SECRET);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);

    const tokRes = await fetch(tokenUrl.toString());
    if (!tokRes.ok) {
      const txt = await tokRes.text().catch(()=> "");
      console.error("[FB oauth] token error", tokRes.status, txt, "redirect_uri:", redirectUri);
      return Response.redirect(`${BASE_URL}/claim?error=token_exchange_failed`, 302);
    }
    const tokJson = await tokRes.json().catch(()=> ({}));
    const access_token = tokJson?.access_token;
    if (!access_token) {
      console.error("[FB oauth] token response missing access_token", tokJson);
      return Response.redirect(`${BASE_URL}/claim?error=no_access_token`, 302);
    }

    // appsecret_proof = HMAC-SHA256(access_token, app_secret)
    const appsecret_proof = crypto
      .createHmac("sha256", FB_APP_SECRET)
      .update(access_token)
      .digest("hex");

    // 2) Fetch profile fields (only approved ones appear for public users)
    const fields = [
      "id",
      "name",
      "email",
      // these require review for non-role users:
      "birthday",
      "hometown",
      "location",
      "picture.type(large){url}"
    ].join(",");

    const meUrl = new URL("https://graph.facebook.com/v24.0/me");
    meUrl.searchParams.set("fields", fields);
    meUrl.searchParams.set("access_token", access_token);
    meUrl.searchParams.set("appsecret_proof", appsecret_proof);

    const meRes = await fetch(meUrl.toString());
    if (!meRes.ok) {
      const txt = await meRes.text().catch(()=> "");
      console.error("[FB oauth] /me error", meRes.status, txt);
      return Response.redirect(`${BASE_URL}/claim?error=profile_fetch_failed`, 302);
    }
    const me = await meRes.json().catch(()=> ({}));

    // Normalize fields (defensive)
    const fbUserId = me?.id || null;
    const name     = me?.name || null;
    const email    = me?.email || null;
    const birthday = me?.birthday || null;
    const hometown = typeof me?.hometown === "object" ? me.hometown?.name : (me?.hometown || null);
    const location = typeof me?.location === "object" ? me.location?.name : (me?.location || null);
    const picture  = me?.picture?.data?.url || null;

    if (!fbUserId) {
      console.warn("[FB oauth] /me missing id", me);
      return Response.redirect(`${BASE_URL}/claim?error=profile_missing_id`, 302);
    }

    // 3) Store against PSID; mark verified
    const col = await usersCol();
    await col.updateOne(
      { psid },
      {
        $set: {
          psid,
          fbUserId,
          name,
          email,
          birthday,
          hometown,
          location,
          picture,
          verified: true,
          dailyCount: 0,
          dailyAt: null,
          followClaim: "claimed",
          followClaimAt: Date.now(),
          updatedAt: Date.now(),
        }
      },
      { upsert: true }
    );

    // 4) Optional Messenger ping
    await sendText(psid, "You're verified via Facebook Login! 🎉 Daily 100 chats unlocked. Welcome!");

    // 5) Back to your UI
    return Response.redirect(`${BASE_URL}/claim?ok=1`, 302);
  } catch (e) {
    console.error("[FB oauth] callback fatal", e);
    return Response.redirect(`${BASE_URL}/claim?error=server_error`, 302);
  }
}
