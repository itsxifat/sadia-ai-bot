// app/api/messenger/webhook/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { generateReplyLLM } from "../../../lib/sadia-ai.js"; // ✅ ESM needs extension

const PAGE_TOKEN  = process.env.MESSENGER_PAGE_TOKEN || "";
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || "";

function log(...a) { console.log("[WEBHOOK]", ...a); }
function isEcho(evt) { return Boolean(evt.message?.is_echo); }

async function fbSend(body) {
  if (!PAGE_TOKEN) {
    console.error("[SendAPI error] Missing MESSENGER_PAGE_TOKEN");
    return false;
  }
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text();
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
  // FB limit is ~2000 chars; keep replies compact
  const msg = String(text || "").slice(0, 1200);
  return fbSend({ recipient: { id: psid }, message: { text: msg } });
}
async function humanPause(text) {
  // human-ish delay (cap to keep under webhook time)
  const wpm = 140;
  const ms = Math.min(2200, Math.max(500, ((String(text||"").split(/\s+/).length)/wpm)*60000));
  await new Promise(r => setTimeout(r, ms));
}

/**
 * NOTE: In-memory state is ephemeral on serverless. For production, swap to Redis/DB.
 */
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
  // GC after 5 minutes
  const t = setTimeout(() => st.processedMids.delete(mid), 5 * 60 * 1000);
  // .unref() only if available (Node runtime)
  if (typeof t.unref === "function") t.unref();
}

// ===== Verification =====
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

// ===== Events =====
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
        // Skip echoes & non-message events we don't care about
        if (isEcho(evt)) continue;
        if (!evt.sender?.id) continue;

        const psid = evt.sender.id;
        const mid  = evt.message?.mid;
        const textIn = evt.message?.text?.trim();

        // ignore delivery/read/postback/attachments silently
        if (!mid || !textIn) {
          log("non-text or missing mid; ignoring", { psid, hasText: !!textIn, hasMid: !!mid });
          continue;
        }

        const st = getState(psid);
        if (st.processedMids.has(mid)) { log("dup mid; skip", mid); continue; }
        rememberMid(psid, mid);

        const now = Date.now();
        if (st.cooldownUntil && now < st.cooldownUntil) {
          log("cooldown active; suppress reply");
          continue;
        }

        log("event", { psid, textIn, mid });
        await markSeen(psid);
        await sendTyping(psid, true);

        let reply = await generateReplyLLM({ psid, userText: textIn });

        // AI failed → one soft notice then cooldown (no spam)
        if (reply == null) {
          if (!st.lastReplyAt || now - st.lastReplyAt > 60_000) {
            const soft = "Ekto tech jhamela hocche. Abar chesta kortesi, thik hoye jabe 🙂";
            await humanPause(soft);
            await sendText(psid, soft);
            st.lastReply = soft;
            st.lastReplyAt = now;
          }
          st.cooldownUntil = now + 45_000;
          await sendTyping(psid, false);
          continue;
        }

        // Same reply too soon → suppress
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
    // Always 200 to stop FB retries if we already handled entries
    return new Response("OK", { status: 200 });
  }
}
