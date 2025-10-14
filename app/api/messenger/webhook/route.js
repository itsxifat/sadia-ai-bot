export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { generateReplyLLM } from "../../../lib/sadia-ai"; // Adjusted path for clarity

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
  if (!res.ok) {
    const txt = await res.text();
    console.error("[SendAPI error]", res.status, txt, "BODY:", JSON.stringify(body));
  }
  return res.ok;
}

async function sendSenderAction(psid, action) {
    return fbSend({ recipient: { id: psid }, sender_action: action });
}

// ✅ IMPROVEMENT: Added a dedicated function for marking messages as seen.
async function markSeen(psid) {
    return sendSenderAction(psid, 'mark_seen');
}

async function sendTyping(psid, on = true) {
  return sendSenderAction(psid, on ? "typing_on" : "typing_off");
}

async function sendText(psid, text) {
  return fbSend({ recipient: { id: psid }, message: { text } });
}

async function humanPause(text) {
  // ✅ IMPROVEMENT: Adjusted WPM to a more realistic 180 from 32.
  const wpm = 180;
  const words = (text || "").split(/\s+/).length;
  const ms = Math.min(2800, Math.max(600, (words / wpm) * 60000));
  await new Promise(r => setTimeout(r, ms));
}


/**
 * критический: In-Memory State Limitation
 * The 'psidState' map is stored in memory. In a serverless environment (like Vercel),
 * this memory is NOT persistent. The function instance can be shut down after a period
 * of inactivity, wiping all state.
 *
 * For production, replace this with a persistent store like Redis (Upstash) or Firestore.
 */
const psidState = new Map();

function getState(psid) {
  if (!psidState.has(psid)) {
    psidState.set(psid, {
      processedMids: new Set(),
      lastReply: null,
      lastReplyAt: 0,
      cooldownUntil: 0
    });
  }
  return psidState.get(psid);
}

function rememberMid(psid, mid) {
  const st = getState(psid);
  st.processedMids.add(mid);
  // Schedule deletion to prevent memory bloat
  setTimeout(() => st.processedMids.delete(mid), 5 * 60 * 1000).unref?.();
}


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

export async function POST(req) {
  try {
    const body = await req.json();
    if (body.object !== "page") return new Response("Not a page object", { status: 404 });

    for (const entry of body.entry || []) {
      for (const evt of entry.messaging || []) {
        if (isEcho(evt)) continue;

        const psid = evt.sender?.id;
        const textIn = evt.message?.text?.trim();
        const mid = evt.message?.mid;
        log("event", { psid, textIn, mid });

        if (!psid || !textIn || !mid) continue;

        const st = getState(psid);
        if (st.processedMids.has(mid)) {
          log("skip duplicate mid", mid);
          continue;
        }
        rememberMid(psid, mid);

        const now = Date.now();
        if (st.cooldownUntil && now < st.cooldownUntil) {
          log("cooldown active; suppress reply");
          continue;
        }

        // ✅ IMPROVEMENT: Mark as seen for better UX
        await markSeen(psid);
        await sendTyping(psid, true);

        let reply = await generateReplyLLM({ psid, userText: textIn });

        if (reply == null) {
          if (!st.lastReplyAt || now - st.lastReplyAt > 60000) {
            const soft = "Ekto tech jhamela hocche. Abar chesta kortesi, thik hoye jabe 🙂";
            await humanPause(soft); // Pause even on soft error
            await sendText(psid, soft);
            st.lastReply = soft;
            st.lastReplyAt = now;
          }
          st.cooldownUntil = now + 45 * 1000;
          await sendTyping(psid, false);
          continue;
        }

        if (st.lastReply === reply && (now - st.lastReplyAt) < 30000) {
          log("suppress duplicate reply within 30s");
          await sendTyping(psid, false);
          continue;
        }

        await humanPause(reply);
        await sendText(psid, reply);
        await sendTyping(psid, false);

        st.lastReply = reply;
        st.lastReplyAt = Date.now();
        // No need for psidState.set(psid, st) since getState returns a direct reference
      }
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (e) {
    console.error("[WEBHOOK error]", e);
    return new Response("Internal Server Error", { status: 500 });
  }
}
