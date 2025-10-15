// app/api/auth/facebook/callback/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { usersCol } from "../../../../lib/mongo.js";
import { verifySignature } from "../../../../lib/sign.js";

const FB_APP_ID = process.env.FB_APP_ID || "";
const FB_APP_SECRET = process.env.FB_APP_SECRET || "";
const FB_REDIRECT_URI = process.env.FB_REDIRECT_URI || "";
const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";
const BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

async function fbSend(body){
  if (!PAGE_TOKEN) return false;
  const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  return res.ok;
}
async function sendText(psid, text){
  if (!PAGE_TOKEN) return false;
  return fbSend({ recipient:{ id: psid }, message:{ text: String(text).slice(0,1200) } });
}

export async function GET(req) {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state"); // our signed PSID token
  const err   = u.searchParams.get("error");

  if (err) return Response.redirect(`${BASE_URL}/claim?error=${encodeURIComponent(err)}`, 302);

  const data = verifySignature(state);
  if (!data?.psid) return Response.redirect(`${BASE_URL}/claim?error=invalid_state`, 302);
  const psid = String(data.psid);

  // 1) Exchange code → access_token
  const tokenUrl = new URL("https://graph.facebook.com/v24.0/oauth/access_token");
  tokenUrl.searchParams.set("client_id", FB_APP_ID);
  tokenUrl.searchParams.set("client_secret", FB_APP_SECRET);
  tokenUrl.searchParams.set("redirect_uri", FB_REDIRECT_URI);
  tokenUrl.searchParams.set("code", code || "");

  const tokRes = await fetch(tokenUrl);
  if (!tokRes.ok) {
    const txt = await tokRes.text().catch(()=> "");
    console.error("[FB oauth] token error", tokRes.status, txt);
    return Response.redirect(`${BASE_URL}/claim?error=token_exchange_failed`, 302);
  }
  const tokJson = await tokRes.json();
  const access_token = tokJson.access_token;

  // 2) Fetch profile fields (only approved ones will be filled for real users)
  // Add/remove fields as your permissions allow
  const fields = [
    "id",
    "name",
    "email",
    "birthday",     // needs user_birthday
    "hometown",     // needs user_hometown
    "location",     // needs user_location
    "picture.type(large){url}",
  ].join(",");

  const meUrl = new URL("https://graph.facebook.com/v24.0/me");
  meUrl.searchParams.set("fields", fields);
  meUrl.searchParams.set("access_token", access_token);

  const meRes = await fetch(meUrl);
  if (!meRes.ok) {
    const txt = await meRes.text().catch(()=> "");
    console.error("[FB oauth] me error", meRes.status, txt);
    return Response.redirect(`${BASE_URL}/claim?error=profile_fetch_failed`, 302);
  }
  const me = await meRes.json();

  // Normalize
  const fbUserId = me.id || null;
  const name = me.name || null;
  const email = me.email || null;
  const birthday = me.birthday || null;
  const hometown = typeof me.hometown === "object" ? me.hometown.name : (me.hometown || null);
  const location = typeof me.location === "object" ? me.location.name : (me.location || null);
  const picture = me.picture?.data?.url || null;

  // 3) Store against PSID; mark verified
  const col = await usersCol();
  await col.updateOne(
    { psid },
    { $set: {
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
      } },
    { upsert: true }
  );

  // 4) Optional: ping them on Messenger
  await sendText(psid, "You're verified via Facebook Login! 🎉 Daily 100 chats unlocked. Welcome!");

  // 5) Send them back to your claim page (success UI) or anywhere
  return Response.redirect(`${BASE_URL}/claim?ok=1`, 302);
}
