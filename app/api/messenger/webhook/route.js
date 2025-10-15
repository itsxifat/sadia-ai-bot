// app/api/messenger/webhook/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { generateReplyLLM } from "../../../lib/sadia-ai.js";
import { usersCol } from "../../../lib/mongo.js";
import { touchAndGateUser } from "../../../lib/user-gate.js";
import { signPayload } from "../../../lib/sign.js";
import { ytFetchAndUpload } from "../../../lib/yt.js";
import { YT_QUEUE } from "../../../lib/task-queue.js";

const PAGE_TOKEN   = process.env.MESSENGER_PAGE_TOKEN || "";
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || "";
const BASE_URL     = (process.env.PUBLIC_BASE_URL || "https://example.com").replace(/\/+$/,"");

// Root-admin PSIDs (cannot be banned/demoted)
const ADMIN_SET = new Set(
  (process.env.ADMIN_PSIDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

function log(...a) { console.log("[WEBHOOK]", ...a); }
function isEcho(evt) { return Boolean(evt.message?.is_echo); }

async function fbSend(body) {
  if (!PAGE_TOKEN) { console.error("[SendAPI] Missing MESSENGER_PAGE_TOKEN"); return false; }
  const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(body), cache: "no-store" });
  if (!res.ok) {
    const txt = await res.text().catch(()=> "");
    console.error("[SendAPI error]", res.status, txt, "BODY:", JSON.stringify(body));
  }
  return res.ok;
}
async function sendSenderAction(psid, action) { return fbSend({ recipient: { id: psid }, sender_action: action }); }
async function markSeen(psid){ return sendSenderAction(psid, "mark_seen"); }
async function sendTyping(psid, on=true){ return sendSenderAction(psid, on ? "typing_on" : "typing_off"); }
async function sendText(psid, text){ return fbSend({ recipient:{ id: psid }, message:{ text: String(text||"").slice(0,1200) } }); }
async function sendAudio(psid, url) {
  return fbSend({
    recipient: { id: psid },
    message: { attachment: { type: "audio", payload: { url, is_reusable: true } } }
  });
}

// keep-typing loop (refreshed every ~7s)
async function typingLoop(psid, stopSignal) {
  try {
    while (!stopSignal.stopped) {
      await sendTyping(psid, true);
      await new Promise(r => setTimeout(r, 7000)); // refresh typing
    }
  } catch {}
}

// Follow card + web form link
function followCard(psid) {
  const token = signPayload({ psid });
  const text = "Follow our Page to unlock full chat with Sadia 💚\n\nType: -followed  or  -notfollowed\nOr share your name & profile link:";
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
            { type: "postback", title: "Not Yet",          payload: "FOLLOW_NOTYET" },
            {
              type: "web_url",
              title: "Share Name & Profile",
              url: `${BASE_URL}/claim-info?t=${encodeURIComponent(token)}`,
              messenger_extensions: true,
              webview_height_ratio: "tall"
            }
          ]
        }
      }
    }
  });
}

// Show onboarding (text + buttons + link) at most once per 6h for unverified users
async function maybeShowOnboarding(psid) {
  const col = await usersCol();
  const u = await col.findOne({ psid }, { projection: { _id:0, verified:1, onboardAt:1 } }) || {};
  if (u.verified) return;

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const now = Date.now();
  if (u.onboardAt && (now - u.onboardAt) < SIX_HOURS) return;

  const token = signPayload({ psid });
  const link  = `${BASE_URL}/claim-info?t=${encodeURIComponent(token)}`;
  const txt = [
    "👋 To unlock full chat with Sadia:",
    "• Tap: I’ve Followed ✅ or Not Yet (buttons below)",
    "• Or type: -followed  /  -notfollowed",
    "• Share name: -name Your Name",
    "• Share profile link: -profile https://your-profile",
    "",
    `Or fill this form: ${link}`,
  ].join("\n");

  await sendText(psid, txt);
  await followCard(psid);

  await col.updateOne({ psid }, { $set: { onboardAt: now, updatedAt: now } }, { upsert: true });
}

async function humanPause(text) {
  const wpm = 140;
  const ms = Math.min(2200, Math.max(500, ((String(text||"").split(/\s+/).length)/wpm)*60000));
  await new Promise(r => setTimeout(r, ms));
}

const psidState = new Map();
function getState(psid) {
  if (!psidState.has(psid)) {
    psidState.set(psid, { processedMids: new Set(), lastReply: null, lastReplyAt: 0, cooldownUntil: 0 });
  }
  return psidState.get(psid);
}
function rememberMid(psid, mid) {
  const st = getState(psid);
  st.processedMids.add(mid);
  const t = setTimeout(() => st.processedMids.delete(mid), 5 * 60 * 1000);
  if (typeof t.unref === "function") t.unref();
}

async function isAdmin(psid) {
  if (ADMIN_SET.has(psid)) return true;
  const col = await usersCol();
  const u = await col.findOne({ psid }, { projection: { _id:0, isAdmin:1 } });
  return !!u?.isAdmin;
}

/* ===== Verification (GET) ===== */
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return new Response(challenge, { status: 200 });
  return new Response("Forbidden", { status: 403 });
}

/* ===== Events (POST) ===== */
export async function POST(req) {
  try {
    if (!PAGE_TOKEN) { console.error("[WEBHOOK] Missing MESSENGER_PAGE_TOKEN"); return new Response("Server misconfigured", { status: 500 }); }

    const body = await req.json();
    if (body.object !== "page") return new Response("Not a page object", { status: 404 });

    for (const entry of body.entry || []) {
      for (const evt of entry.messaging || []) {
        const psid = evt.sender?.id;
        if (!psid) continue;

        // Postbacks
        if (evt.postback?.payload) {
          const payload = evt.postback.payload;
          const col = await usersCol();
          if (payload === "FOLLOW_CLAIMED") {
            await col.updateOne({ psid }, { $set: { followClaim: "claimed", followClaimAt: Date.now(), updatedAt: Date.now() } }, { upsert: true });
            await sendText(psid, "Got it! Our team will verify you soon. 💚");
            continue;
          }
          if (payload === "FOLLOW_NOTYET") {
            await col.updateOne({ psid }, { $set: { followClaim: "declined", followClaimAt: Date.now(), updatedAt: Date.now() } }, { upsert: true });
            await sendText(psid, "Cool—take your time. You’ll get 10 free replies without follow.");
            continue;
          }
        }

        if (isEcho(evt)) continue;

        const mid = evt.message?.mid;
        const textIn = evt.message?.text?.trim();
        if (!mid || !textIn) { log("non-text or missing mid; ignoring", { psid, hasText: !!textIn, hasMid: !!mid }); continue; }

        const st = getState(psid);
        if (st.processedMids.has(mid)) { log("dup mid; skip", mid); continue; }
        rememberMid(psid, mid);

        // ===== FB Lite + Commands =====
        if (/^-followed\b/i.test(textIn)) {
          const col = await usersCol();
          await col.updateOne({ psid }, { $set: { followClaim: "claimed", followClaimAt: Date.now(), updatedAt: Date.now() } }, { upsert: true });
          await sendText(psid, "Noted. We’ll verify you soon. 💚");
          continue;
        }
        if (/^-notfoll+owed\b/i.test(textIn) || /^-notfollowed\b/i.test(textIn)) {
          const col = await usersCol();
          await col.updateOne({ psid }, { $set: { followClaim: "declined", followClaimAt: Date.now(), updatedAt: Date.now() } }, { upsert: true });
          await sendText(psid, "All good. You still have 10 free replies without follow.");
          continue;
        }
        if (/^-name\s+(.+)/i.test(textIn)) {
          const name = textIn.replace(/^-name\s+/i, "").trim().slice(0, 80);
          if (name.length < 2) { await sendText(psid, "Name ta arektu boro din 🙂"); continue; }
          const col = await usersCol();
          await col.updateOne({ psid }, { $set: { name, updatedAt: Date.now() } }, { upsert: true });
          await sendText(psid, `Saved your name as: ${name}`);
          continue;
        }
        if (/^-profile\s+(\S+)/i.test(textIn)) {
          const url = textIn.replace(/^-profile\s+/i, "").trim();
          if (!/^https?:\/\/\S{3,200}$/i.test(url)) { await sendText(psid, "Profile URL thik na mone hocche. https:// diye din 🙂"); continue; }
          const col = await usersCol();
          await col.updateOne({ psid }, { $set: { profileUrl: url, updatedAt: Date.now() } }, { upsert: true });
          await sendText(psid, "Profile link saved. ✅");
          continue;
        }

        // ----- -yt <YouTube URL> : QUEUED with progress typing -----
        if (/^-yt\s+(\S+)/i.test(textIn)) {
          const m = textIn.match(/^-yt\s+(\S+)/i);
          const you = m?.[1]?.trim();

          // Gate (respect bans / follow / daily)
          const gate = await touchAndGateUser(psid, { action: "yt" });
          if (gate.reason === "banned") { await sendText(psid, "Access is restricted."); continue; }
          if (gate.reason === "need_follow") {
            await sendText(psid, "Follow required to use music feature 💚 Type -followed after following, or open the verification card.");
            await followCard(psid);
            continue;
          }
          if (gate.reason === "daily_limit") { await sendText(psid, "Daily 100 limit reached; try again tomorrow."); continue; }

          // Queue job
          const placeInQueue = YT_QUEUE.size() + 1;
          await sendText(psid, `🎵 Request received. ${placeInQueue > 1 ? `You are #${placeInQueue} in queue.` : "Starting soon…"}`);

          // Typing loop while waiting/working
          const stopSignal = { stopped: false };
          typingLoop(psid, stopSignal).catch(()=>{});

          YT_QUEUE.enqueue({
            key: `yt:${psid}:${Date.now()}`,
            psid,
            run: async () => {
              const stageText = (stage, payload) => {
                switch (stage) {
                  case "info":
                    return `🎧 ${payload.title} (${Math.floor(payload.lengthSec/60)}:${String(payload.lengthSec%60).padStart(2,"0")})`;
                  case "download_start":
                    return "⬇️ Downloading audio…";
                  case "download_progress":
                    return `⬇️ Downloading… ${payload.mb} MB`;
                  case "download_done":
                    return "✅ Downloaded. Preparing upload…";
                  case "upload_start":
                    return "⬆️ Uploading…";
                  case "upload_done":
                    return "✅ Uploaded. Sending to you…";
                }
                return null;
              };

              let lastSent = 0;
              const onStage = async (s, p) => {
                const now = Date.now();
                const msg = stageText(s, p);
                if (msg && now - lastSent > 2200) {
                  lastSent = now;
                  await sendText(psid, msg);
                }
              };

              try {
                await onStage("info", { title: "Loading metadata…", lengthSec: 0 });
                const { url, title, lengthSec } = await ytFetchAndUpload(you, onStage);
                await sendAudio(psid, url);
                await sendText(psid, `🎶 Sent: ${title} (${Math.floor(lengthSec/60)}:${String(lengthSec%60).padStart(2,"0")}) — enjoy!`);
              } catch (e) {
                const code = String(e.message || e);
                let msg = "Couldn’t fetch that video.";
                if (code === "invalid_youtube_url") msg = "Invalid YouTube link. Please send the full URL.";
                else if (code === "too_long") msg = "Sorry, max audio length is 8 minutes.";
                else if (code === "file_too_large") msg = "Audio too large to send.";
                else if (code === "no_audio_format") msg = "No compatible audio stream found.";
                await sendText(psid, msg);
              } finally {
                stopSignal.stopped = true;
                await sendTyping(psid, false);
              }
            }
          });

          continue;
        }

        // ----- Admin & help -----
        if (/^-help\b/i.test(textIn)) {
          const col = await usersCol();
          const u = (await col.findOne({ psid }, { projection: { _id:0 } })) || {};
          const isAdm = ADMIN_SET.has(psid) || !!u.isAdmin;
          const token = signPayload({ psid });
          const link  = `${BASE_URL}/claim-info?t=${encodeURIComponent(token)}`;
          const lines = [
            "Commands:",
            "• -followed / -notfollowed",
            "• -name <Your Name>",
            "• -profile <https://your.profile>",
            "• -yt <YouTube URL>  → get audio as a voice message",
            `• Web form: ${link}`,
            ...(isAdm ? [
              "• -ban <psid?>      (admin)",
              "• -unban <psid?>    (admin)",
              "• -addadmin <psid>  (admin)",
              "• -deladmin <psid>  (admin)",
            ] : []),
            "",
            "Your status:",
            `• verified: ${u.verified ? "yes" : "no"}`,
            `• vip: ${u.vip ? "yes" : "no"}`,
            `• banned: ${u.banned ? "yes" : "no"}`,
            `• admin: ${isAdm ? "yes" : "no"}`,
            `• free used: ${u.freeCount || 0} / 10`,
            `• daily used: ${u.dailyCount || 0} / 100`,
          ];
          await sendText(psid, lines.join("\n"));
          continue;
        }

        // -ban / -unban
        if (/^-(?:ban|unban)\b/i.test(textIn)) {
          const isAdm = await isAdmin(psid);
          if (!isAdm) { await sendText(psid, "This command is admin-only."); continue; }
          const banFlag = /^-ban\b/i.test(textIn);
          const m = textIn.match(/^(?:-ban|-unban)\s+(\d{5,})/i);
          const target = m ? m[1] : psid;

          const targetIsRoot = ADMIN_SET.has(target);
          const col = await usersCol();
          const tu = await col.findOne({ psid: target }, { projection: { _id:0, isAdmin:1 } });
          const targetIsAdmin = targetIsRoot || !!tu?.isAdmin;

          if (banFlag) {
            if (target === psid) { await sendText(psid, "You can’t ban yourself."); continue; }
            if (targetIsAdmin) { await sendText(psid, "Admins cannot be banned."); continue; }
          }

          await col.updateOne({ psid: target }, { $set: { banned: banFlag, updatedAt: Date.now() } }, { upsert: true });
          await sendText(psid, `${banFlag ? "Banned" : "Unbanned"}: ${target}`);
          continue;
        }

        // -addadmin
        if (/^-addadmin\s+(\d{5,})/i.test(textIn)) {
          const isAdm = await isAdmin(psid);
          if (!isAdm) { await sendText(psid, "This command is admin-only."); continue; }
          const m = textIn.match(/^-addadmin\s+(\d{5,})/i);
          const target = m?.[1];
          if (!target) { await sendText(psid, "Usage: -addadmin <psid>"); continue; }
          const col = await usersCol();
          await col.updateOne({ psid: target }, { $set: { isAdmin: true, banned: false, updatedAt: Date.now() } }, { upsert: true });
          await sendText(psid, `Admin added: ${target}`);
          continue;
        }

        // -deladmin
        if (/^-deladmin\s+(\d{5,})/i.test(textIn)) {
          const isAdm = await isAdmin(psid);
          if (!isAdm) { await sendText(psid, "This command is admin-only."); continue; }
          const m = textIn.match(/^-deladmin\s+(\d{5,})/i);
          const target = m?.[1];
          if (!target) { await sendText(psid, "Usage: -deladmin <psid>"); continue; }
          if (ADMIN_SET.has(target)) { await sendText(psid, "Root admins cannot be demoted."); continue; }
          if (target === psid && ADMIN_SET.size === 0) { await sendText(psid, "You can’t demote yourself."); continue; }
          const col = await usersCol();
          await col.updateOne({ psid: target }, { $set: { isAdmin: false, updatedAt: Date.now() } }, { upsert: true });
          await sendText(psid, `Admin removed: ${target}`);
          continue;
        }

        // ===== Cooldown =====
        const now = Date.now();
        if (st.cooldownUntil && now < st.cooldownUntil) { log("cooldown active; suppress reply"); continue; }

        await markSeen(psid);
        await sendTyping(psid, true);

        // Gate + counters
        const gate = await touchAndGateUser(psid);

        // Unverified → show onboarding (throttled)
        if (!gate.user?.verified) {
          await maybeShowOnboarding(psid);
        }

        if (!gate.allowLLM) {
          await sendTyping(psid, false);
          if (gate.reason === "banned") {
            await sendText(psid, "Access is currently restricted.");
          } else if (gate.reason === "need_follow") {
            const token = signPayload({ psid });
            const link  = `${BASE_URL}/claim-info?t=${encodeURIComponent(token)}`;
            const msg = [
              "Follow required to continue chatting 💚",
              "Type: -followed  or  -notfollowed",
              "Share name: -name Your Name",
              "Share profile: -profile https://your-profile",
              `Or fill this form: ${link}`,
            ].join("\n");
            await sendText(psid, msg);
            await followCard(psid);
          } else if (gate.reason === "daily_limit") {
            await sendText(psid, "Daily 100 chat limit reached 🙂 Try again after midnight (Dhaka).");
          }
          continue;
        }

        // Normal LLM flow (within free window or verified/vip)
        let reply = await generateReplyLLM({ psid, userText: textIn });
        if (reply == null) {
          const soft = "Ekto tech jhamela hocche. Abar chesta kortesi 🙂";
          await humanPause(soft);
          await sendText(psid, soft);
          st.lastReply = soft; st.lastReplyAt = now; st.cooldownUntil = now + 45_000;
          await sendTyping(psid, false);
          continue;
        }

        if (st.lastReply === reply && (now - st.lastReplyAt) < 30_000) {
          log("suppress duplicate reply within 30s");
          await sendTyping(psid, false);
          continue;
        }

        await humanPause(reply);
        await sendText(psid, reply);
        await sendTyping(psid, false);
        st.lastReply = reply; st.lastReplyAt = Date.now();
      }
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (e) {
    console.error("[WEBHOOK error]", e);
    // 200 so FB doesn't retry endlessly (if we already processed entries)
    return new Response("OK", { status: 200 });
  }
}
