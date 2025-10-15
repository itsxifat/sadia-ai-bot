// lib/yt.js
// Robust YouTube → audio uploader for Messenger
// Requires: npm i ytdl-core
// Also set: BLOB_READ_WRITE_TOKEN (Vercel Blob R/W token)

const MAX_SECONDS = 8 * 60;          // 8 minutes
const MAX_BYTES   = 20 * 1024 * 1024; // ~20 MB cap for memory safety

function normalizeYouTubeUrl(input) {
  try {
    const u = new URL(input);
    const host = u.hostname.toLowerCase();

    // reject playlists
    if (u.searchParams.get("list")) {
      const err = new Error("playlist_not_supported");
      err.code = "playlist_not_supported";
      throw err;
    }

    // shorts → watch
    if (host.includes("youtube.com") && u.pathname.startsWith("/shorts/")) {
      const id = u.pathname.split("/")[2];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }

    // youtu.be → watch
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\/+/, "");
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }

    // keep timestamps; ytdl-core ignores them for download anyway
    return u.toString();
  } catch {
    const err = new Error("invalid_youtube_url");
    err.code = "invalid_youtube_url";
    throw err;
  }
}

async function uploadToVercelBlob(buf, filenameExt = "webm") {
  const token = process.env.BLOB_READ_WRITE_TOKEN || "";
  if (!token) {
    const err = new Error("upload_failed");
    err.code = "upload_failed";
    throw err;
  }
  const key = `yt-${Date.now()}-${Math.random().toString(36).slice(2)}.${filenameExt}`;

  // Vercel Blob simple PUT endpoint
  const endpoint = `https://blob.vercel-storage.com/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`;
  const res = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: buf
  });
  if (!res.ok) {
    const err = new Error("upload_failed");
    err.code = "upload_failed";
    throw err;
  }
  // public URL is the same URL without the token
  return `https://blob.vercel-storage.com/${encodeURIComponent(key)}`;
}

/**
 * ytFetchAndUpload(url, onStage?)
 *  - url: YouTube URL (any form)
 *  - onStage: (stage, payload) => void
 *     stages: info, download_start, download_progress, download_done, upload_start, upload_done
 *  returns: { url, title, lengthSec }
 */
export async function ytFetchAndUpload(inputUrl, onStage) {
  const ytdl = await import("ytdl-core");

  const url = normalizeYouTubeUrl(inputUrl);
  if (!ytdl.validateURL(url)) {
    const err = new Error("invalid_youtube_url");
    err.code = "invalid_youtube_url";
    throw err;
  }

  // Fetch info
  let info;
  try {
    info = await ytdl.getInfo(url);
  } catch (e) {
    // common causes: private/age/region
    const msg = String(e?.message || "").toLowerCase();
    const err = new Error("download_failed");
    if (msg.includes("age")) err.code = "age_restricted";
    else if (msg.includes("unavailable") || msg.includes("private")) err.code = "download_failed";
    else if (msg.includes("not available in your country")) err.code = "region_blocked";
    throw err;
  }

  const title = info.videoDetails?.title || "Unknown title";
  const lengthSec = Number(info.videoDetails?.lengthSeconds || 0);
  if (!Number.isFinite(lengthSec) || lengthSec <= 0) {
    const err = new Error("download_failed");
    err.code = "download_failed";
    throw err;
  }
  if (lengthSec > MAX_SECONDS) {
    const err = new Error("too_long");
    err.code = "too_long";
    throw err;
  }

  // prefer audio-only formats
  const format = ytdl.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" });
  if (!format) {
    const err = new Error("no_audio_format");
    err.code = "no_audio_format";
    throw err;
  }

  onStage?.("info", { title, lengthSec });

  // Download → buffer (kept small by MAX_BYTES)
  onStage?.("download_start");
  const stream = ytdl.default(url, { quality: "highestaudio", filter: "audioonly", dlChunkSize: 512 * 1024 });

  let received = 0;
  const chunks = [];
  const ext = /mp4|m4a/i.test(format.container || "") ? "m4a" : "webm";

  await new Promise((resolve, reject) => {
    stream.on("data", (c) => {
      received += c.length;
      if (received > MAX_BYTES) {
        const err = new Error("file_too_large");
        err.code = "file_too_large";
        stream.destroy(err);
        return;
      }
      chunks.push(c);
      if (received % (1024 * 1024) < c.length) {
        const mb = Math.round(received / (1024 * 1024));
        onStage?.("download_progress", { mb });
      }
    });
    stream.once("end", resolve);
    stream.once("error", (e) => {
      const err = new Error("download_failed");
      err.code = "download_failed";
      reject(err);
    });
  });

  onStage?.("download_done");

  const buf = Buffer.concat(chunks);

  onStage?.("upload_start");
  const publicUrl = await uploadToVercelBlob(buf, ext);
  onStage?.("upload_done");

  return { url: publicUrl, title, lengthSec };
}
