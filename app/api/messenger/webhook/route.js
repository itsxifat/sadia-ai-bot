// app/api/messenger/webhook/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { generateReplyLLM } from "../../../lib/sadia-ai.js";

const PAGE_TOKEN   = process.env.MESSENGER_PAGE_TOKEN || "";
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || "";
const PAGE_URL     = process.env.MESSENGER_PAGE_URL || ""; // e.g. https://facebook.com/yourpage

function log(...a) { console.log("[WEBHOOK]", ...a); }
function isEcho(evt) { return Boolean(evt.message?.is_echo); }

// ───────────────────────────────────────────────────────────
// Facebook Send API helpers
// ───────────────────────────────────────────────────────────
async function fbSend(body, attempt = 1) {
  if (!PAGE_TOKEN) { console.error("[SendAPI error] Missing MESSENGER_PAGE_TOKEN"); return false; }
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: ac.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("[SendAPI error]", res.status, txt, "BODY:", JSON.stringify(body));
      if (attempt < 2 && res.status >= 500) return fbSend(body, attempt + 1);
    }
    return res.ok;
  } catch (e) {
    console.error("[SendAPI network/abort]", String(e));
    if (attempt < 2) return fbSend(body, attempt + 1);
    return false;
  } finally {
    clearTimeout(to);
  }
}

async function sendSenderAction(psid, action) {
  return fbSend({ recipient: { id: psid }, sender_action: action });
}
async function markSeen(psid)              { return sendSenderAction(psid, "mark_seen"); }
async function sendTyping(psid, on = true) { return sendSenderAction(psid, on ? "typing_on" : "typing_off"); }
async function sendText(psid, text) {
  const msg = String(text || "").slice(0, 1200);
  return fbSend({ recipient: { id: psid }, message: { text: msg } });
}
async function humanPause(text) {
  const wpm = 140;
  const ms = Math.min(2200, Math.max(500, ((String(text||"").split(/\s+/).length)/wpm)*60000));
  await new Promise(r => setTimeout(r, ms));
}

// ───────────────────────────────────────────────────────────
// In-memory state (serverless-ephemeral). Swap to Redis for prod.
// ───────────────────────────────────────────────────────────
/**
 * {
 *   processedMids: Set<string>,
 *   lastReply: string|null,
 *   lastReplyAt: number,
 *   cooldownUntil: number,
 *   verified: boolean,     // user pressed "I've Followed"
 *   freeCount: number,     // AI replies sent while unverified
 *   nudgeSent: boolean,    // we already sent the initial nudge
 *   lastNudgeAt: number,   // when we sent the nudge
 *   lastReminderAt: number // last time we sent limit reminder
 * }
 */
const psidState = new Map();
function getState(psid){
  if (!psidState.has(psid)) {
    psidState.set(psid, {
      processedMids: new Set(),
      lastReply: null,
      lastReplyAt: 0,
      cooldownUntil: 0,
      verified: false,
      freeCount: 0,
      nudgeSent: false,
      lastNudgeAt: 0,
      lastReminderAt: 0,
    });
  }
  return psidState.get(psid);
}
function rememberMid(psid, mid){
  const st = getState(psid);
  st.processedMids.add(mid);
  const t = setTimeout(() => st.processedMids.delete(mid), 5 * 60 * 1000);
  if (typeof t.unref === "function") t.unref();
}

// ───────────────────────────────────────────────────────────
// Follow reminder (Button template) + postback
// ───────────────────────────────────────────────────────────
async function sendFollowReminder(psid) {
  const text = "First follow our Facebook Page, then chat with Sadia 💚 (Tap below)";
  const buttons = [];
  if (PAGE_URL) buttons.push({ type: "web_url", url: PAGE_URL, title: "Follow Page" });
  buttons.push({ type: "postback", title: "I’ve Followed ✅", payload: "FOLLOW_DONE" });

  const payload = {
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text,
          buttons,
        },
      },
    },
  };
  return fbSend(payload);
}

// ───────────────────────────────────────────────────────────
// GET (verification)
// ───────────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────────
// POST (events)
// ───────────────────────────────────────────────────────────
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

        // Postback: soft verification
        if (evt.postback?.payload === "FOLLOW_DONE" && evt.sender?.id) {
          const psid = evt.sender.id;
          const st = getState(psid);
          st.verified = true;
          st.cooldownUntil = 0;
          await sendText(psid, "Dhonnobad! Sadia is fully on now. 💫");
          continue;
        }

        if (isEcho(evt) || !evt.sender?.id) continue;

        const psid = evt.sender.id;
        const mid  = evt.message?.mid;
        const textIn = evt.message?.text?.trim();

        // ignore non-text or missing mid
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

        // ── Follow-first logic ───────────────────────────────

        // 1) Initial nudge: only once per user (no spam)
        if (!st.verified && !st.nudgeSent) {
          st.nudgeSent = true;
          st.lastNudgeAt = now;
          await markSeen(psid);
          await sendTyping(psid, true);
          await sendText(psid, "Hey! Prothome amader Page follow korle aro valo 💚. Tumi 10 ta free reply pabe.");
          if (PAGE_URL) await sendFollowReminder(psid);
          await sendTyping(psid, false);
          // we still continue to answer with LLM (counts toward free quota)
          // (don't return; drop through to LLM below)
        }

        // 2) Hard limit: after 10 free replies while unverified → reminder ONLY (throttled)
        if (!st.verified && st.freeCount >= 10) {
          const REMINDER_COOLDOWN_MS = 120000; // 2 minutes
          if (now - (st.lastReminderAt || 0) >= REMINDER_COOLDOWN_MS) {
            st.lastReminderAt = now;
            await markSeen(psid);
            await sendTyping(psid, true);
            await sendFollowReminder(psid);
            await sendTyping(psid, false);
          } else {
            log("reminder throttled; skipping repeat");
          }
          // no LLM calls beyond the free limit
          continue;
        }

        // ── Normal AI flow (under quota or verified) ────────
        await markSeen(psid);
        await sendTyping(psid, true);

        log("event", { psid, textIn, mid });

        let reply = await generateReplyLLM({ psid, userText: textIn });

        // AI failed → soft notice + cooldown
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

        // same reply too soon → suppress
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

        // Count toward free quota if not verified
        if (!st.verified) st.freeCount = (st.freeCount || 0) + 1;
      }
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (e) {
    console.error("[WEBHOOK error]", e);
    return new Response("OK", { status: 200 }); // prevent FB retries
  }
}
