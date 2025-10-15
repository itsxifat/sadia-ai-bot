export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { generateReplyLLM } from "../../../lib/sadia-ai.js";
import { usersCol } from "../../../lib/mongo.js";

const PAGE_TOKEN   = process.env.MESSENGER_PAGE_TOKEN || "";
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || "";
const PAGE_URL     = process.env.MESSENGER_PAGE_URL || "";
const AUTO_VERIFY_ON_CLAIM = (process.env.SADIA_AUTO_VERIFY_ON_CLAIM || "") === "1";

const FREE_LIMIT = 10;
const DAILY_LIMIT_VERIFIED = 100;

function log(...a){ console.log("[WEBHOOK]", ...a); }
function isEcho(evt){ return Boolean(evt.message?.is_echo); }

// ── FB Send API
async function fbSend(body, attempt = 1){
  if (!PAGE_TOKEN){ console.error("[SendAPI] Missing MESSENGER_PAGE_TOKEN"); return false; }
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const ac = new AbortController(); const to = setTimeout(()=>ac.abort(), 8000);
  try{
    const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body), cache:"no-store", signal: ac.signal });
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
async function sendText(psid, text){ return fbSend({ recipient:{ id: psid }, message:{ text: String(text||"").slice(0,1200) } }); }
async function humanPause(text){ const wpm=140; const ms=Math.min(2200, Math.max(500, ((String(text||"").split(/\s+/).length)/wpm)*60000)); await new Promise(r=>setTimeout(r,ms)); }

async function sendFollowPrompt(psid){
  const text = "Follow our Facebook Page to unlock full chat with Sadia 💚";
  const buttons = [];
  if (PAGE_URL) buttons.push({ type: "web_url", url: PAGE_URL, title: "Open Page" });
  buttons.push({ type: "postback", title: "I’ve Followed ✅", payload: "FOLLOW_DONE" });
  buttons.push({ type: "postback", title: "Not Yet",        payload: "FOLLOW_NOT_YET" });
  return fbSend({ recipient:{ id: psid }, message:{ attachment:{ type:"template", payload:{ template_type:"button", text, buttons }}}});
}
async function sendPendingReview(psid){
  return sendText(psid, "Dhonnobad! Tumi follow claim korechho. Review cholche—verify hole instantly unlock hobe. 💚");
}
async function sendVerifiedInfo(psid){
  return sendText(psid, `You're verified now! 🎉 Daily ${DAILY_LIMIT_VERIFIED} chat unlocked (auto-reset each day).`);
}

// ── DB helpers
const MEM_TTL = 60_000; const memCache = new Map();
function blank(psid){
  return {
    psid,
    processedMids: [],
    lastReply: null, lastReplyAt: 0, cooldownUntil: 0,
    verified: false, vip: false,
    freeCount: 0,
    nudgeSent: false,
    followClaim: "unknown", followClaimAt: 0,
    dailyCount: 0, dailyAt: null, // YYYY-MM-DD Asia/Dhaka
    name: null, picture: null, locale: null,
    __profileError: false,
    updatedAt: Date.now(),
  };
}
async function users(){ return usersCol(); }
function todayDhaka(){
  return new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Dhaka", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
}
async function getState(psid){
  const c = memCache.get(psid);
  if (c && (Date.now()-c.ts)<MEM_TTL) return c.state;
  const col = await users();
  const doc = await col.findOne({ psid });
  const st = doc ? doc : blank(psid);
  memCache.set(psid, { state: st, ts: Date.now() });
  return st;
}
function rememberMidLocal(st, mid){
  const arr = Array.isArray(st.processedMids) ? st.processedMids : [];
  arr.push(mid); if (arr.length > 50) arr.shift(); return arr;
}
async function saveState(psid, patch){
  const col = await users();
  const base = await getState(psid);
  const next = { ...base, ...patch, processedMids:(patch?.processedMids ?? base.processedMids ?? []).slice(-50), updatedAt: Date.now() };
  await col.updateOne({ psid }, { $set: next }, { upsert: true });
  memCache.set(psid, { state: next, ts: Date.now() });
  return next;
}

// ── Messenger Profile (robust)
async function fetchMessengerProfile(psid){
  try{
    if (!PAGE_TOKEN || !psid) return null;
    const fields = "first_name,last_name,profile_pic,locale";
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(psid)}?fields=${fields}&access_token=${encodeURIComponent(PAGE_TOKEN)}`;
    const res = await fetch(url, { cache:"no-store" });
    if (!res.ok){
      const txt = await res.text().catch(()=> "");
      console.error("[PROFILE] HTTP", res.status, txt, "PSID:", psid);
      return { __profileError: true };
    }
    const j = await res.json().catch(()=> null);
    if (!j) return null;
    return {
      name: [j.first_name, j.last_name].filter(Boolean).join(" ") || null,
      picture: j.profile_pic || null,
      locale: j.locale || null,
      __profileError: false,
    };
  }catch(e){ console.error("[PROFILE] error", e); return null; }
}

// ===== GET verify
export async function GET(req){
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return new Response(challenge, { status: 200 });
  return new Response("Forbidden", { status: 403 });
}

// ===== POST events
export async function POST(req){
  try{
    if (!PAGE_TOKEN){ console.error("[WEBHOOK] Missing MESSENGER_PAGE_TOKEN"); return new Response("Server misconfigured", { status: 500 }); }
    const body = await req.json();
    if (body.object !== "page") return new Response("Not a page object", { status: 404 });

    for (const entry of body.entry || []){
      for (const evt of entry.messaging || []){
        // Postbacks
        if (evt.postback?.payload && evt.sender?.id){
          const psid = evt.sender.id;
          const payload = evt.postback.payload;

          if (payload === "FOLLOW_DONE"){
            const patch = { followClaim:"claimed", followClaimAt: Date.now() };
            if (AUTO_VERIFY_ON_CLAIM) patch.verified = true;
            await saveState(psid, patch);
            await sendText(psid, AUTO_VERIFY_ON_CLAIM ? `Awesome! Verified. Daily ${DAILY_LIMIT_VERIFIED} chats unlocked.` : "Noted! We’ll review and unlock soon. 💚");
            continue;
          }
          if (payload === "FOLLOW_NOT_YET"){
            await saveState(psid, { followClaim:"not_yet", followClaimAt: Date.now() });
            await sendText(psid, "No pressure! You still have a few free replies. Follow anytime from the button. 🙂");
            continue;
          }
        }

        // Messages
        if (isEcho(evt) || !evt.sender?.id) continue;
        const psid = evt.sender.id;
        const mid  = evt.message?.mid;
        const textIn = evt.message?.text?.trim();
        if (!mid || !textIn) continue;

        let st = await getState(psid);
        if (Array.isArray(st.processedMids) && st.processedMids.includes(mid)) continue;

        const now = Date.now();
        if (st.cooldownUntil && now < st.cooldownUntil) continue;

        // Fetch profile when missing (retry until hard error)
        if (!st.name && st.__profileError !== true) {
          const prof = await fetchMessengerProfile(psid);
          if (prof) st = await saveState(psid, prof);
        }

        // First nudge
        if (!st.verified && !st.nudgeSent){
          await markSeen(psid); await sendTyping(psid, true);
          await sendText(psid, "Hey! Prothome Page follow korle full access pabe. Tomar jonno 10 ta free reply on 😉");
          await sendFollowPrompt(psid);
          await sendTyping(psid, false);
          st = await saveState(psid, { nudgeSent: true, processedMids: rememberMidLocal(st, mid) });
        } else {
          st = await saveState(psid, { processedMids: rememberMidLocal(st, mid) });
        }

        // VIP: unlimited
        if (st.vip){
          await markSeen(psid); await sendTyping(psid, true);
          let reply = await generateReplyLLM({ psid, userText: textIn });
          reply ??= "Small glitch—try again 🙂";
          await humanPause(reply); await sendText(psid, reply); await sendTyping(psid, false);
          await saveState(psid, { lastReply: reply, lastReplyAt: Date.now() });
          continue;
        }

        // Not verified & over free limit → every message enforce state
        if (!st.verified && st.freeCount >= FREE_LIMIT){
          if (st.followClaim === "claimed") {
            await sendPendingReview(psid);    // pending every message
          } else { // "not_yet" or "unknown"
            await sendFollowPrompt(psid);     // follow prompt every message
          }
          continue;
        }

        // Verified: enforce daily 100 (Dhaka)
        if (st.verified){
          const today = todayDhaka();
          let dailyCount = st.dailyCount || 0;
          let dailyAt    = st.dailyAt || today;
          if (dailyAt !== today){ dailyAt = today; dailyCount = 0; }

          if (dailyCount >= DAILY_LIMIT_VERIFIED){
            await sendText(psid, `Daily limit reached (${DAILY_LIMIT_VERIFIED}). It auto-resets each day (Dhaka time).`);
            await saveState(psid, { dailyAt, dailyCount });
            continue;
          }

          await markSeen(psid); await sendTyping(psid, true);
          let reply = await generateReplyLLM({ psid, userText: textIn });
          if (reply == null){
            const soft = "Ekto tech jhamela hocche. Abar chesta kortesi, thik hoye jabe 🙂";
            await humanPause(soft); await sendText(psid, soft); await sendTyping(psid, false);
            await saveState(psid, { lastReply: soft, lastReplyAt: Date.now() });
            continue;
          }
          await humanPause(reply); await sendText(psid, reply); await sendTyping(psid, false);
          await saveState(psid, { lastReply: reply, lastReplyAt: Date.now(), dailyAt, dailyCount: dailyCount+1 });
          continue;
        }

        // Under free limit + not verified → normal LLM + increment freeCount
        await markSeen(psid); await sendTyping(psid, true);
        let reply = await generateReplyLLM({ psid, userText: textIn });
        if (reply == null){
          const soft = "Ekto tech jhamela hocche. Abar chesta kortesi, thik hoye jabe 🙂";
          await humanPause(soft); await sendText(psid, soft); await sendTyping(psid, false);
          await saveState(psid, { lastReply: soft, lastReplyAt: Date.now() });
          continue;
        }
        await humanPause(reply); await sendText(psid, reply); await sendTyping(psid, false);
        await saveState(psid, { lastReply: reply, lastReplyAt: Date.now(), freeCount: (st.freeCount||0)+1 });
      }
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  }catch(e){
    console.error("[WEBHOOK error]", e);
    return new Response("OK", { status: 200 });
  }
}
