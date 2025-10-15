// app/api/messenger/webhook/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { generateReplyLLM } from "../../../lib/sadia-ai.js";
import { usersCol } from "../../../lib/mongo.js";
import { touchAndGateUser } from "../../../lib/user-gate.js";

const PAGE_TOKEN   = process.env.MESSENGER_PAGE_TOKEN || "";
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || "";

function log(...a) { console.log("[WEBHOOK]", ...a); }
function isEcho(evt) { return Boolean(evt.message?.is_echo); }

async function fbSend(body) {
  if (!PAGE_TOKEN) {
    console.error("[SendAPI error] Missing MESSENGER_PAGE_TOKEN");
    return false;
  }
  const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=>"");
    console.error("[SendAPI error]", res.status, txt, "BODY:", JSON.stringify(body));
  }
  return res.ok;
}

async function sendSenderAction(psid, action) {
  return fbSend({ recipient: { id: psid }, sender_action: action });
}
async function markSeen(psid)  { return sendSenderAction(psid, "mark_seen"); }
async function sendTyping(psid, on = true) { return sendSenderAction(psid, on ? "typing_on" : "typing_off"); }
async function sendText(psid, text) {
  const msg = String(text || "").slice(0, 1200);
  return fbSend({ recipient: { id: psid }, message: { text: msg } });
}

function followCard(psid) {
  // Button template + command fallback text
  const text = "Follow our Facebook Page to unlock full chat with Sadia 💚\n\nWrite: -followed  or  -notfollowed";
  return fbSend({
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text,
          buttons: [
            { type: "postback", title: "I’ve Followed ✅", payload: "FOLLOW_CLAIMED" },
            { type: "postback", title: "Not Yet",        payload: "FOLLOW_NOTYET" }
          ]
        }
      }
    }
  });
}

async function humanPause(text) {
  const wpm = 140;
  const ms = Math.min(2200, Math.max(500, ((String(text||"").split(/\s+/).length)/wpm)*60000));
  await new Promise(r => setTimeout(r, ms));
}

/** ephemeral in-memory mid dedupe */
const psidState = new Map();
function getState(psid) {
  if (!psidState.has(psid)) {
    psidState.set(psid, {
      processedMids: new Set(),
      lastReply: null,
      lastReplyAt: 0,
      cooldownUntil: 0,
    });
  }
  return psidState.get(psid);
}
function rememberMid(psid, mid) {
  const st = getState(psid);
  st.processedMids.add(mid);
  const t = setTimeout(() => st.processedMids.delete(mid), 5 * 60 * 1000);
  if (typeof t.unref === "function") t.unref();
}

/* ===== Verification (GET) ===== */
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

/* ===== Events (POST) ===== */
export async function POST(req) {
  try {
    if (!PAGE_TOKEN) {
      console.error("[WEBHOOK] Missing MESSENGER_PAGE_TOKEN");
      return new Response("Server misconfigured", { status: 500 });
    }

    const body = await req.json();
    if (body.object !== "page") return new Response("Not a page object", { status: 404 });

    for (const entry of body.entry || []) {
      for (const evt of entry.messaging || []) {
        const psid = evt.sender?.id;
        if (!psid) continue;

        // Handle Postbacks (buttons)
        if (evt.postback?.payload) {
          const payload = evt.postback.payload;
          if (payload === "FOLLOW_CLAIMED") {
            const col = await usersCol();
            await col.updateOne(
              { psid },
              { $set: { followClaim: "claimed", followClaimAt: Date.now(), updatedAt: Date.now() } },
              { upsert: true }
            );
            await sendText(psid, "Nice! Our team will verify you soon. For now you still have 10 free replies if not verified yet. 💚");
            continue;
          }
          if (payload === "FOLLOW_NOTYET") {
            const col = await usersCol();
            await col.updateOne(
              { psid },
              { $set: { followClaim: "declined", followClaimAt: Date.now(), updatedAt: Date.now() } },
              { upsert: true }
            );
            await sendText(psid, "Cool—take your time. You have 10 free replies before follow is required. 🙂");
            continue;
          }
        }

        // Messages (ignore echos and non-text)
        if (isEcho(evt)) continue;

        const mid    = evt.message?.mid;
        const textIn = evt.message?.text?.trim();
        if (!mid || !textIn) {
          log("non-text or missing mid; ignoring", { psid, hasText: !!textIn, hasMid: !!mid });
          continue;
        }

        const st = getState(psid);
        if (st.processedMids.has(mid)) { log("dup mid; skip", mid); continue; }
        rememberMid(psid, mid);

        // Commands for FB Lite:
        if (/^-followed\b/i.test(textIn)) {
          const col = await usersCol();
          await col.updateOne(
            { psid },
            { $set: { followClaim: "claimed", followClaimAt: Date.now(), updatedAt: Date.now() } },
            { upsert: true }
          );
          await sendText(psid, "Got it! We’ll verify you soon. 💚");
          continue;
        }
        if (/^-notfollowed\b/i.test(textIn) || /^-notfol+owed\b/i.test(textIn)) {
          const col = await usersCol();
          await col.updateOne(
            { psid },
            { $set: { followClaim: "declined", followClaimAt: Date.now(), updatedAt: Date.now() } },
            { upsert: true }
          );
          await sendText(psid, "No worries. You still have 10 free replies, then follow is required.");
          continue;
        }

        const now = Date.now();
        if (st.cooldownUntil && now < st.cooldownUntil) {
          log("cooldown active; suppress reply");
          continue;
        }

        await markSeen(psid);
        await sendTyping(psid, true);

        // Gatekeeping: limits and verification
        const gate = await touchAndGateUser(psid);

        if (!gate.allowLLM) {
          await sendTyping(psid, false);

          if (gate.reason === "need_follow") {
            // Always show the card (no spam: only when message arrives)
            await followCard(psid);
          } else if (gate.reason === "daily_limit") {
            await sendText(psid, "Daily 100 chat limit reached for today 🙂 Try again after midnight (Dhaka).");
          }
          continue;
        }

        // Call LLM normally
        let reply = await generateReplyLLM({ psid, userText: textIn });

        if (reply == null) {
          const soft = "Ekto tech jhamela hocche. Abar chesta kortesi, thik hoye jabe 🙂";
          await humanPause(soft);
          await sendText(psid, soft);
          st.lastReply = soft;
          st.lastReplyAt = now;
          st.cooldownUntil = now + 45_000;
          await sendTyping(psid, false);
          continue;
        }

        // De-dup within 30s
        if (st.lastReply === reply && (now - st.lastReplyAt) < 30_000) {
          log("suppress duplicate reply within 30s");
          await sendTyping(psid, false);
          continue;
        }

        await humanPause(reply);
        await sendText(psid, reply);
        await sendTyping(psid, false);

        st.lastReply = reply;
        st.lastReplyAt = Date.now();
      }
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (e) {
    console.error("[WEBHOOK error]", e);
    return new Response("OK", { status: 200 }); // prevent FB retries
  }
}
