// app/api/messenger/webhook/route.js
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

function isEcho(evt){ return Boolean(evt.message?.is_echo); }

// ── FB Send API
async function fbSend(body, attempt = 1){
  if (!PAGE_TOKEN && body?.message?.attachment?.payload?.template_type === "button") {
    // If no page token, avoid template sends that may fail; fall back to plain text
    const text = "Follow our Facebook Page to unlock full chat with Sadia 💚\n\nFB Lite users: type -followed or -notfollowed";
    return fbSend({ recipient: body.recipient, message: { text } });
  }
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
async function sendSenderAction(psid, action){ if (!PAGE_TOKEN) return false; return fbSend({ recipient:{ id: psid }, sender_action: action }); }
async function markSeen(psid){ return sendSenderAction(psid, "mark_seen"); }
async function sendTyping(psid, on=true){ return sendSenderAction(psid, on ? "typing_on":"typing_off"); }
async function sendText(psid, text){ return fbSend({ recipient:{ id: psid }, message:{ text: String(text||"").slice(0,1200) } }); }
async function humanPause(text){ const wpm=140; const ms=Math.min(2200, Math.max(500, ((String(text||"").split(/\s+/).length)/wpm)*60000)); await new Promise(r=>setTimeout(r,ms)); }

async function sendFollowPrompt(psid){
  const text = "Follow our Facebook Page to unlock full chat with Sadia 💚\n\nFB Lite users: type -followed or -notfollowed";
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

// ======= FRESH-STATE CACHE (fix for Unverify) =======
const MEM_TTL = 3000; // 3s cache; set to 0 to disable
const memCache = new Map();

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
    name: null, picture: null, locale: null, // profile
    birthday: null, hometown: null, location: null, // self-reported
    __profileError: !PAGE_TOKEN, // if no token, don't retry Graph
    updatedAt: 0,
  };
}
async function users(){ return usersCol(); }
function cacheSet(psid, state){ memCache.set(psid, { state, ts: Date.now() }); return state; }

/** Get a state fresh enough for auth/limits. */
async function getState(psid){
  const cached = memCache.get(psid);
  const now = Date.now();

  if (!cached || (MEM_TTL > 0 && (now - cached.ts) > MEM_TTL)) {
    const col = await users();
    const doc = await col.findOne({ psid }) || blank(psid);
    return cacheSet(psid, doc);
  }

  try{
    const col = await users();
    const fresh = await col.findOne({ psid }, { projection: { updatedAt: 1 } });
    const dbUpdated = fresh?.updatedAt || 0;
    const cacheUpdated = cached.state?.updatedAt || 0;

    if (dbUpdated > cacheUpdated) {
      const full = await col.findOne({ psid }) || blank(psid);
      return cacheSet(psid, full);
    }
    return cached.state;
  }catch{
    return cached.state;
  }
}
function rememberMidLocal(st, mid){
  const arr = Array.isArray(st.processedMids) ? st.processedMids : [];
  arr.push(mid); if (arr.length > 50) arr.shift(); return arr;
}
async function saveState(psid, patch){
  const col = await users();
  const base = await getState(psid);
  const next = {
    ...blank(psid),
    ...base,
    ...patch,
    processedMids: (patch?.processedMids ?? base.processedMids ?? []).slice(-50),
    updatedAt: Date.now(),
  };
  await col.updateOne({ psid }, { $set: next }, { upsert: true });
  cacheSet(psid, next);
  return next;
}
// ======= /FRESH-STATE CACHE =======

// ── Messenger Profile (robust; degrades if no token)
async function fetchMessengerProfile(psid){
  try{
    if (!PAGE_TOKEN || !psid) return { __profileError: true };
    const fields = "first_name,last_name,profile_pic,locale";
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(psid)}?fields=${fields}&access_token=${encodeURIComponent(PAGE_TOKEN)}`;
    const res = await fetch(url, { cache:"no-store" });
    if (!res.ok){
      const txt = await res.text().catch(()=> "");
      console.error("[PROFILE] HTTP", res.status, txt, "PSID:", psid);
      return { __profileError: true };
    }
    const j = await res.json().catch(()=> null);
    if (!j) return { __profileError: true };
    return {
      name: [j.first_name, j.last_name].filter(Boolean).join(" ") || null,
      picture: j.profile_pic || null,
      locale: j.locale || null,
      __profileError: false,
    };
  }catch(e){ console.error("[PROFILE] error", e); return { __profileError: true }; }
}

// ---- User-supplied profile commands (no token needed)
function parseKV(cmd, text){
  const m = text.trim().match(new RegExp(`^${cmd}\\s+(.{1,80})$`, "i"));
  return m ? m[1].trim() : null;
}
function isCmd(text, ...alts){
  const t = (text||"").trim().toLowerCase();
  return alts.some(a => t.startsWith(a));
}
async function sendProfilePrompt(psid){
  return fbSend({
    recipient:{ id: psid },
    message:{
      text: "Chai ekto info to personalize 🙂\nCommands:\n- -name <Your Name>\n- -birthday YYYY-MM-DD\n- -hometown <City>\n- -location (share location)\n\nFB Lite: just type the commands.",
      quick_replies: [
        { content_type: "location" },
        { content_type: "text", title: "Set Name", payload: "PROMPT_SET_NAME" },
        { content_type: "text", title: "Set Birthday", payload: "PROMPT_SET_BDAY" },
        { content_type: "text", title: "Set Hometown", payload: "PROMPT_SET_HOME" },
      ]
    }
  });
}

// ===== Helpers: follow commands for FB Lite =====
function isFollowedCmd(s=""){
  const t = s.trim().toLowerCase();
  return t === "-followed" || t === "/followed" || t === "followed";
}
function isNotFollowedCmd(s=""){
  const t = s.trim().toLowerCase();
  return t === "-notfollowed" || t === "-notfolllowed" || t === "/notfollowed" || t === "notfollowed";
}

// ===== Verification (GET)
export async function GET(req){
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return new Response(challenge, { status: 200 });
  return new Response("Forbidden", { status: 403 });
}

// ===== Events (POST)
export async function POST(req){
  try{
    const body = await req.json();
    if (body.object !== "page") return new Response("Not a page object", { status: 404 });

    for (const entry of body.entry || []){
      for (const evt of entry.messaging || []){

        // Postbacks (full Messenger buttons)
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
            await sendText(psid, "No pressure! You still have a few free replies. Follow anytime. 🙂\nFB Lite tip: type -followed or -notfollowed");
            continue;
          }
        }

        // Messages
        if (isEcho(evt) || !evt.sender?.id) continue;
        const psid = evt.sender.id;
        const mid  = evt.message?.mid;
        const textIn = evt.message?.text?.trim() || "";
        if (!mid) continue;

        let st = await getState(psid);
        if (st.verified) st = await getState(psid); // ensure fresh unverify

        if (Array.isArray(st.processedMids) && st.processedMids.includes(mid)) continue;
        const now = Date.now();
        if (st.cooldownUntil && now < st.cooldownUntil) continue;

        // FB Lite follow commands (do NOT count toward limits)
        if (textIn) {
          if (isFollowedCmd(textIn)) {
            const patch = { followClaim:"claimed", followClaimAt: Date.now() };
            if (AUTO_VERIFY_ON_CLAIM) patch.verified = true;
            await saveState(psid, patch);
            await sendText(psid, AUTO_VERIFY_ON_CLAIM ? `Awesome! Verified. Daily ${DAILY_LIMIT_VERIFIED} chats unlocked.` : "Claim received! We’ll review and unlock soon. 💚");
            continue;
          }
          if (isNotFollowedCmd(textIn)) {
            await saveState(psid, { followClaim:"not_yet", followClaimAt: Date.now() });
            await sendText(psid, "Cool—take your time. You still have a few free replies.\nType -followed when you’re done.");
            continue;
          }
        }

        // User-supplied profile commands (do NOT count toward limits)
        if (textIn) {
          if (isCmd(textIn, "-name ")) {
            const name = parseKV("-name", textIn);
            if (name && name.length >= 2){
              const safe = name.replace(/[^\p{L}\p{M}\s.'-]/gu,"").slice(0,60);
              await saveState(psid, { name: safe });
              await sendText(psid, `Noted! Tomar nam set kora holo: ${safe}`);
            } else {
              await sendText(psid, "Format: -name Your Name");
            }
            continue;
          }
          if (isCmd(textIn, "-birthday ")) {
            const b = parseKV("-birthday", textIn);
            const ok = /^\d{4}-\d{2}-\d{2}$/.test(b||"");
            if (ok){
              await saveState(psid, { birthday: b });
              await sendText(psid, `Birthday saved: ${b}`);
            } else {
              await sendText(psid, "Format: -birthday YYYY-MM-DD");
            }
            continue;
          }
          if (isCmd(textIn, "-hometown ")) {
            const city = parseKV("-hometown", textIn);
            if (city){
              const safe = city.replace(/[^\p{L}\p{M}\s.'-]/gu,"").slice(0,80);
              await saveState(psid, { hometown: safe });
              await sendText(psid, `Hometown saved: ${safe}`);
            } else {
              await sendText(psid, "Format: -hometown City");
            }
            continue;
          }
          if (textIn === "-profile") {
            await sendProfilePrompt(psid);
            continue;
          }
        }

        // Handle location attachments (from quick reply)
        const attachments = evt.message?.attachments || [];
        const loc = attachments.find(a => a.type === "location" && a.payload?.coordinates);
        if (loc) {
          const { lat, long } = loc.payload.coordinates;
          await saveState(psid, { location: { lat, long, at: Date.now() }});
          await sendText(psid, `Location saved. Lat: ${lat.toFixed(5)}, Long: ${long.toFixed(5)}`);
          continue;
        }

        // Fetch profile via Graph when missing (retry until hard error)
        if (!st.name && st.__profileError !== true) {
          const prof = await fetchMessengerProfile(psid);
          if (prof) st = await saveState(psid, prof);
        }
        // If still missing name & Graph blocked, nudge for manual profile once
        if (!st.name && st.__profileError === true && !st.profilePrompted) {
          await sendText(psid, "FB permissions ektu tight—amar profile fetch hocche na. Tumi ichcha korle nijer info set korte paro:");
          await sendProfilePrompt(psid);
          await saveState(psid, { profilePrompted: true });
        }

        // First nudge (also mention Lite commands)
        if (!st.verified && !st.nudgeSent){
          await markSeen(psid); await sendTyping(psid, true);
          await sendText(psid, "Hey! Prothome Page follow korle full access pabe. Tomar jonno 10 ta free reply on 😉\n\nFB Lite: type -followed or -notfollowed");
          await sendFollowPrompt(psid);
          await sendTyping(psid, false);
          st = await saveState(psid, { nudgeSent: true, processedMids: rememberMidLocal(st, mid) });
          continue;
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

        // Not verified & over free limit → enforce every message
        if (!st.verified && st.freeCount >= FREE_LIMIT){
          if (st.followClaim === "claimed") {
            await sendPendingReview(psid);
          } else {
            await sendFollowPrompt(psid);
          }
          continue;
        }

        // Verified: enforce daily 100 (Dhaka)
        if (st.verified){
          const today = new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Dhaka", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
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
