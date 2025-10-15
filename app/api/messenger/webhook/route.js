export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { generateReplyLLM } from "../../../lib/sadia-ai.js";
import { usersCol } from "../../../lib/mongo.js";

const PAGE_TOKEN   = process.env.MESSENGER_PAGE_TOKEN || "";
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || "";
const PAGE_URL     = process.env.MESSENGER_PAGE_URL || "";
const AUTO_VERIFY_ON_CLAIM = (process.env.SADIA_AUTO_VERIFY_ON_CLAIM || "") === "1";

function log(...a){ console.log("[WEBHOOK]", ...a); }
function isEcho(evt){ return Boolean(evt.message?.is_echo); }

// ---- Send API helpers ----
async function fbSend(body, attempt = 1){
  if (!PAGE_TOKEN){ console.error("[SendAPI] Missing MESSENGER_PAGE_TOKEN"); return false; }
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const ac = new AbortController(); const to = setTimeout(()=>ac.abort(), 8000);
  try{
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body), cache: "no-store", signal: ac.signal,
    });
    if (!res.ok){
      const txt = await res.text().catch(()=> "");
      console.error("[SendAPI error]", res.status, txt, "BODY:", JSON.stringify(body));
      if (attempt < 2 && res.status >= 500) return fbSend(body, attempt+1);
    }
    return res.ok;
  }catch(e){
    console.error("[SendAPI net/abort]", String(e));
    if (attempt < 2) return fbSend(body, attempt+1);
    return false;
  }finally{ clearTimeout(to); }
}
async function sendSenderAction(psid, action){ return fbSend({ recipient:{ id: psid }, sender_action: action }); }
async function markSeen(psid){ return sendSenderAction(psid, "mark_seen"); }
async function sendTyping(psid, on=true){ return sendSenderAction(psid, on ? "typing_on":"typing_off"); }
async function sendText(psid, text){
  const msg = String(text || "").slice(0, 1200);
  return fbSend({ recipient: { id: psid }, message: { text: msg } });
}
async function humanPause(text){
  const wpm = 140;
  const ms = Math.min(2200, Math.max(500, ((String(text||"").split(/\s+/).length)/wpm)*60000));
  await new Promise(r => setTimeout(r, ms));
}

async function sendFollowPrompt(psid){
  const text = "Follow our Facebook Page to unlock full chat with Sadia 💚 (Tap an option)";
  const buttons = [];
  if (PAGE_URL) buttons.push({ type: "web_url", url: PAGE_URL, title: "Open Page" });
  buttons.push({ type: "postback", title: "I’ve Followed ✅", payload: "FOLLOW_DONE" });
  buttons.push({ type: "postback", title: "Not Yet", payload: "FOLLOW_NOT_YET" });

  return fbSend({
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: { template_type: "button", text, buttons },
      },
    },
  });
}

async function sendLimitReminder(psid){
  const text = "Quick reminder: please follow our Page to continue chatting with Sadia. 💚";
  const buttons = [];
  if (PAGE_URL) buttons.push({ type: "web_url", url: PAGE_URL, title: "Open Page" });
  buttons.push({ type: "postback", title: "I’ve Followed ✅", payload: "FOLLOW_DONE" });
  buttons.push({ type: "postback", title: "Not Yet", payload: "FOLLOW_NOT_YET" });

  return fbSend({
    recipient: { id: psid },
    message: {
      attachment: {
        type: "template",
        payload: { template_type: "button", text, buttons },
      },
    },
  });
}

// ---- DB helpers ----
const MEM_TTL = 60_000; const memCache = new Map(); // psid -> {state, ts}

function blank(psid){
  return {
    psid,
    processedMids: [],
    lastReply: null,
    lastReplyAt: 0,
    cooldownUntil: 0,
    verified: false,
    freeCount: 0,
    nudgeSent: false,
    lastNudgeAt: 0,
    lastReminderAt: 0,
    // manual review fields:
    followClaim: "unknown", // "unknown" | "claimed" | "not_yet"
    followClaimAt: 0,
    // profile cache:
    name: null, picture: null, locale: null,
    updatedAt: Date.now(),
  };
}
async function getState(psid){
  const c = memCache.get(psid);
  if (c && (Date.now()-c.ts)<MEM_TTL) return c.state;
  const col = await usersCol();
  const doc = await col.findOne({ psid });
  const st = doc ? doc : blank(psid);
  memCache.set(psid, { state: st, ts: Date.now() });
  return st;
}
function rememberMidLocal(st, mid){
  const arr = Array.isArray(st.processedMids) ? st.processedMids : [];
  arr.push(mid); if (arr.length > 50) arr.shift();
  return arr;
}
async function saveState(psid, patch){
  const col = await usersCol();
  const base = await getState(psid);
  const next = {
    ...base, ...patch,
    processedMids: (patch?.processedMids ?? base.processedMids ?? []).slice(-50),
    updatedAt: Date.now(),
  };
  await col.updateOne({ psid }, { $set: next }, { upsert: true });
  memCache.set(psid, { state: next, ts: Date.now() });
  return next;
}

// ---- Optional: pull profile fields for admin list ----
async function fetchMessengerProfile(psid){
  try{
    const token = PAGE_TOKEN;
    if (!token) return null;
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(psid)}?fields=first_name,last_name,profile_pic,locale&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      name: [j.first_name, j.last_name].filter(Boolean).join(" ") || null,
      picture: j.profile_pic || null,
      locale: j.locale || null,
    };
  } catch { return null; }
}

// ===== Verification =====
export async function GET(req){
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
export async function POST(req){
  try{
    if (!PAGE_TOKEN){ console.error("[WEBHOOK] Missing MESSENGER_PAGE_TOKEN"); return new Response("Server misconfigured", { status: 500 }); }
    const body = await req.json();
    if (body.object !== "page") return new Response("Not a page object", { status: 404 });

    for (const entry of body.entry || []){
      for (const evt of entry.messaging || []){
        // Postbacks for follow claims
        if (evt.postback?.payload && evt.sender?.id){
          const psid = evt.sender.id;
          const payload = evt.postback.payload;
          if (payload === "FOLLOW_DONE"){
            const patch = { followClaim: "claimed", followClaimAt: Date.now() };
            if (AUTO_VERIFY_ON_CLAIM) patch.verified = true;
            await saveState(psid, patch);
            await sendText(psid, AUTO_VERIFY_ON_CLAIM ? "Awesome! Verified. Sadia is fully on now. 💫" : "Noted! We’ll review soon. Thanks for the follow 💚");
            continue;
          }
          if (payload === "FOLLOW_NOT_YET"){
            await saveState(psid, { followClaim: "not_yet", followClaimAt: Date.now() });
            await sendText(psid, "No pressure! You still have a few free replies. Follow anytime from the button. 🙂");
            continue;
          }
        }

        if (isEcho(evt) || !evt.sender?.id) continue;

        const psid = evt.sender.id;
        const mid  = evt.message?.mid;
        const textIn = evt.message?.text?.trim();

        if (!mid || !textIn){
          log("non-text or missing mid; ignoring", { psid, hasText: !!textIn, hasMid: !!mid });
          continue;
        }

        let st = await getState(psid);
        if (Array.isArray(st.processedMids) && st.processedMids.includes(mid)){ log("dup mid; skip", mid); continue; }

        const now = Date.now();
        if (st.cooldownUntil && now < st.cooldownUntil){ log("cooldown active; suppress reply"); continue; }

        // Onboarding nudge once + store profile for admin
        if (!st.verified && !st.nudgeSent){
          // Grab profile (name, pic) to display in admin queue
          if (!st.name) {
            const prof = await fetchMessengerProfile(psid);
            if (prof) st = await saveState(psid, prof);
          }
          await markSeen(psid);
          await sendTyping(psid, true);
          await sendText(psid, "Hey! Prothome Page follow korle full access pabe. Tomar jonno 10 ta free reply on 😉");
          await sendFollowPrompt(psid);
          await sendTyping(psid, false);
          st = await saveState(psid, { nudgeSent: true, lastNudgeAt: now, processedMids: rememberMidLocal(st, mid) });
          // fallthrough to LLM (counts toward quota)
        } else {
          st = await saveState(psid, { processedMids: rememberMidLocal(st, mid) });
        }

        // Free cap
        if (!st.verified && st.freeCount >= 10){
          const COOL = 120000; // 2 min
          if (now - (st.lastReminderAt || 0) >= COOL){
            await markSeen(psid);
            await sendTyping(psid, true);
            await sendLimitReminder(psid);
            await sendTyping(psid, false);
            await saveState(psid, { lastReminderAt: now, cooldownUntil: Date.now()+30_000 });
          } else {
            log("reminder throttled");
          }
          continue; // do not call LLM
        }

        await markSeen(psid);
        await sendTyping(psid, true);
        log("event", { psid, textIn, mid });

        let reply = await generateReplyLLM({ psid, userText: textIn });

        if (reply == null){
          if (!st.lastReplyAt || now - st.lastReplyAt > 60_000){
            const soft = "Ekto tech jhamela hocche. Abar chesta kortesi, thik hoye jabe 🙂";
            await humanPause(soft); await sendText(psid, soft);
            await saveState(psid, { lastReply: soft, lastReplyAt: now, cooldownUntil: now + 45_000 });
          } else {
            await saveState(psid, { cooldownUntil: now + 45_000 });
          }
          await sendTyping(psid, false);
          continue;
        }

        if (st.lastReply === reply && (now - st.lastReplyAt) < 30_000){
          log("suppress duplicate reply within 30s");
          await sendTyping(psid, false);
          continue;
        }

        await humanPause(reply);
        await sendText(psid, reply);
        await sendTyping(psid, false);

        await saveState(psid, {
          lastReply: reply, lastReplyAt: Date.now(),
          freeCount: st.verified ? st.freeCount : (st.freeCount + 1),
        });
      }
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  }catch(e){
    console.error("[WEBHOOK error]", e);
    return new Response("OK", { status: 200 });
  }
}
