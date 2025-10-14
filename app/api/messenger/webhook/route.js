// app/api/messenger/webhook/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { generateReplyLLM } from "../../../lib/sadia-ai.js";

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;

function log(...a) { console.log("[WEBHOOK]", ...a); }
function isEcho(evt) { return Boolean(evt.message?.is_echo); }

async function fbSend(body) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const ok = res.ok;
  if (!ok) {
    const txt = await res.text();
    console.error("[SendAPI error]", res.status, txt, "BODY:", JSON.stringify(body));
  }
  return ok;
}
async function sendTyping(psid, on = true) {
  return fbSend({ recipient: { id: psid }, sender_action: on ? "typing_on" : "typing_off" });
}
async function sendText(psid, text) {
  return fbSend({ recipient: { id: psid }, message: { text } });
}
async function humanPause(text) {
  const wpm = 32;
  const ms = Math.min(2400, Math.max(500, ((text || "").split(/\s+/).length / wpm) * 60000));
  await new Promise(r => setTimeout(r, ms));
}

/** -------- anti-spam state (in-memory) --------
 * psidState: {
 *   processedMids: Set<string>,  // recent message.mids we've handled
 *   lastReply: string|null,      // last text we sent
 *   lastReplyAt: number,         // ts ms
 *   cooldownUntil: number        // ts ms (don’t reply while in cooldown)
 * }
 */
const psidState = new Map();

// TTL cleanup for processed mids (avoid memory bloat)
function rememberMid(psid, mid) {
  const st = psidState.get(psid) || { processedMids: new Set(), lastReply: null, lastReplyAt: 0, cooldownUntil: 0 };
  st.processedMids.add(mid);
  // schedule delete in 5 minutes
  setTimeout(() => st.processedMids.delete(mid), 5 * 60 * 1000).unref?.();
  psidState.set(psid, st);
  return st;
}
function getState(psid) {
  const st = psidState.get(psid) || { processedMids: new Set(), lastReply: null, lastReplyAt: 0, cooldownUntil: 0 };
  psidState.set(psid, st);
  return st;
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return new Response(challenge, { status: 200 });
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (body.object !== "page") return new Response("Not a page object", { status: 404 });

    for (const entry of body.entry || []) {
      for (const evt of entry.messaging || []) {
        if (isEcho(evt)) continue;

        const psid = evt.sender?.id;
        const textIn = evt.message?.text?.trim();
        const mid   = evt.message?.mid; // unique message id from Messenger
        log("event", { psid, textIn, mid });

        if (!psid || !textIn) continue;

        // ----- 1) de-duplicate on message.mid -----
        if (mid) {
          const st = getState(psid);
          if (st.processedMids.has(mid)) {
            log("skip duplicate mid", mid);
            continue;
          }
          rememberMid(psid, mid);
        }

        const st = getState(psid);
        const now = Date.now();

        // ----- 2) circuit breaker: if in cooldown, stay quiet -----
        if (st.cooldownUntil && now < st.cooldownUntil) {
          log("cooldown active; suppress reply");
          continue;
        }

        await sendTyping(psid, true);
        let reply = await generateReplyLLM({ psid, userText: textIn });

        // ----- 3) if AI failed (reply === null), enter cooldown and send ONE soft notice, once -----
        if (reply == null) {
          // Only send the soft notice if we haven't sent anything in last 60s
          if (!st.lastReplyAt || now - st.lastReplyAt > 60000) {
            const soft = "Ekto tech jhamela hocche. Abar chesta kortesi, thik hoye jabe 🙂";
            await humanPause(soft);
            await sendText(psid, soft);
            st.lastReply = soft;
            st.lastReplyAt = now;
          }
          // Enter cooldown for 45s to prevent spam
          st.cooldownUntil = now + 45 * 1000;
          psidState.set(psid, st);
          await sendTyping(psid, false);
          continue;
        }

        // ----- 4) avoid sending the exact same reply within 30s -----
        if (st.lastReply && st.lastReply === reply && (now - st.lastReplyAt) < 30000) {
          log("suppress duplicate reply within 30s");
          await sendTyping(psid, false);
          continue;
        }

        await humanPause(reply);
        await sendText(psid, reply);
        await sendTyping(psid, false);

        st.lastReply = reply;
        st.lastReplyAt = Date.now();
        psidState.set(psid, st);
      }
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (e) {
    console.error("[WEBHOOK error]", e);
    return new Response("Bad Request", { status: 400 });
  }
}
