// app/api/yt/run/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// let it run long enough to download and upload a short video
export const maxDuration = 300; // seconds

import { ytFetchAndUpload } from "../../../lib/yt.js";

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";

async function fbSend(body) {
  if (!PAGE_TOKEN) return false;
  const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return res.ok;
}
async function sendText(psid, text) {
  return fbSend({ recipient: { id: psid }, message: { text: String(text).slice(0, 1200) } });
}
async function sendTyping(psid, on = true) {
  return fbSend({ recipient: { id: psid }, sender_action: on ? "typing_on" : "typing_off" });
}
async function sendAudio(psid, url) {
  return fbSend({
    recipient: { id: psid },
    message: { attachment: { type: "audio", payload: { url, is_reusable: true } } },
  });
}

// keep typing alive during long work
async function typingLoop(psid, stopSignal) {
  try {
    while (!stopSignal.stopped) {
      await sendTyping(psid, true);
      await new Promise((r) => setTimeout(r, 7000));
    }
  } catch {}
}

export async function POST(req) {
  try {
    const hdr = req.headers.get("x-vercel-background");
    // We strongly advise triggering this endpoint with x-vercel-background: 1
    if (!hdr) {
      // still process, but caller will wait for completion
    }

    const { psid, url } = await req.json();
    if (!psid || !url) return new Response("Bad Request", { status: 400 });

    const stopSignal = { stopped: false };
    typingLoop(psid, stopSignal).catch(() => {});

    let lastSent = 0;
    const onStage = async (stage, payload) => {
      const now = Date.now();
      // throttle progress messages
      if (now - lastSent < 1800 && stage === "download_progress") return;
      lastSent = now;

      const msg = (() => {
        switch (stage) {
          case "info":
            return `🎧 ${payload.title} (${Math.floor(payload.lengthSec / 60)}:${String(payload.lengthSec % 60).padStart(2, "0")})`;
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
          default:
            return null;
        }
      })();

      if (msg) await sendText(psid, msg);
    };

    try {
      await sendText(psid, "🎵 Starting background job…");
      const { url: audioUrl, title, lengthSec } = await ytFetchAndUpload(url, onStage);
      await sendAudio(psid, audioUrl);
      await sendText(
        psid,
        `🎶 Sent: ${title} (${Math.floor(lengthSec / 60)}:${String(lengthSec % 60).padStart(2, "0")}) — enjoy!`
      );
    } catch (e) {
      const code = String(e?.message || e);
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

    // Return immediately if triggered with x-vercel-background
    return new Response(null, { status: 202 });
  } catch (e) {
    console.error("[/api/yt/run] error", e);
    return new Response("OK", { status: 202 });
  }
}
