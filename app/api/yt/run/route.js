// app/api/yt/run/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { ytFetchAndUpload } from "../../../lib/yt.js";

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";

// ---- helpers ----
async function fbSend(body) {
  if (!PAGE_TOKEN) return false;
  const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(PAGE_TOKEN)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}
async function sendText(psid, text) {
  return fbSend({ recipient: { id: psid }, message: { text: String(text).slice(0, 1200) } });
}
async function sendAudio(psid, url) {
  return fbSend({
    recipient: { id: psid },
    message: { attachment: { type: "audio", payload: { url, is_reusable: true } } }
  });
}

function mapErrorToText(code) {
  switch (String(code)) {
    case "invalid_youtube_url": return "The YouTube link looks invalid. Please send the full URL.";
    case "playlist_not_supported": return "Playlists aren’t supported. Please send a single video URL.";
    case "age_restricted": return "That video is age-restricted; can’t fetch audio from it.";
    case "region_blocked": return "That video is blocked in our region.";
    case "too_long": return "Sorry, I only support videos up to 8 minutes.";
    case "no_audio_format": return "No compatible audio stream found for that video.";
    case "download_failed": return "Download failed — the video may be blocked or corrupted.";
    case "file_too_large": return "The audio file is too large to host.";
    case "upload_failed": return "Upload failed while preparing the audio.";
    default: return "Couldn’t fetch that video.";
  }
}

export async function POST(req) {
  try {
    const { psid, url } = await req.json().catch(() => ({}));
    if (!psid || !url) return new Response("Bad Request", { status: 400 });

    // progress pings (rate-limited by ytFetchAndUpload)
    const onStage = async (stage, payload) => {
      switch (stage) {
        case "info": {
          const mins = Math.floor((payload.lengthSec || 0) / 60);
          const secs = String((payload.lengthSec || 0) % 60).padStart(2, "0");
          await sendText(psid, `🎧 ${payload.title || "Loading metadata…"} (${mins}:${secs})`);
          break;
        }
        case "download_start": await sendText(psid, "⬇️ Downloading audio…"); break;
        case "download_progress": {
          const mb = payload?.mb ? ` ${payload.mb} MB` : "";
          await sendText(psid, `⬇️ Downloading…${mb}`);
          break;
        }
        case "download_done": await sendText(psid, "✅ Download complete. Preparing upload…"); break;
        case "upload_start": await sendText(psid, "⬆️ Uploading…"); break;
        case "upload_done": await sendText(psid, "✅ Upload done. Sending…"); break;
      }
    };

    try {
      const { url: audioUrl, title, lengthSec } = await ytFetchAndUpload(url, onStage);
      await sendAudio(psid, audioUrl);
      const mins = Math.floor((lengthSec || 0) / 60);
      const secs = String((lengthSec || 0) % 60).padStart(2, "0");
      await sendText(psid, `🎶 Sent: ${title} (${mins}:${secs}) — enjoy!`);
    } catch (err) {
      console.error("[yt/run] error:", err);
      const msg = mapErrorToText(err?.code || err?.message || err);
      await sendText(psid, msg);
    }

    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error("[yt/run] fatal", e);
    return new Response("OK", { status: 200 });
  }
}
