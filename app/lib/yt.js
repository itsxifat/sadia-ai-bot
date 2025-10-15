// lib/yt.js
// Robust YouTube → audio uploader for Messenger, no 'ytpl' dependency.
// npm i ytdl-core
// Also set: BLOB_READ_WRITE_TOKEN (Vercel Blob R/W token)

const MAX_SECONDS = 12 * 60;            // 12 minutes
const MAX_BYTES   = 24 * 1024 * 1024;   // ~24 MB

function normalizeWatchUrlFromId(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function pickFirst(paramMap, ...names) {
  for (const n of names) if (paramMap.get(n)) return paramMap.get(n);
  return null;
}

// Try to pull first videoId from playlist HTML without external libs
async function resolveFirstVideoFromPlaylist(listId) {
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}&hl=en`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  if (!res.ok) throw Object.assign(new Error("playlist_fetch_failed"), { code: "playlist_fetch_failed" });

  const html = await res.text();

  // quick regex: find the first "playlistVideoRenderer":{"videoId":"XXXXXXXXXXX"
  const m = html.match(/"playlistVideoRenderer"\s*:\s*\{[^}]*"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
  if (m && m[1]) return m[1];

  // fallback: search generic "videoId":"XXXXXXXXXXX" near the start
  const m2 = html.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
  if (m2 && m2[1]) return m2[1];

  throw Object.assign(new Error("playlist_first_failed"), { code: "playlist_first_failed" });
}

/**
 * normalizeYouTubeUrlAny(input)
 *  - Accepts: shorts, youtu.be, watch URLs, timestamps, 'si' params, etc.
 *  - If playlist-only link is given, resolves to the FIRST video in the playlist.
 *  - Returns a normalized watch URL.
 */
export async function normalizeYouTubeUrlAny(input) {
  let u;
  try { u = new URL(input); }
  catch {
    const err = new Error("invalid_youtube_url");
    err.code = "invalid_youtube_url";
    throw err;
  }

  const host = u.hostname.toLowerCase();

  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\/+/, "");
    if (id) return normalizeWatchUrlFromId(id);
  }

  // shorts → watch
  if (host.includes("youtube.com") && u.pathname.startsWith("/shorts/")) {
    const id = u.pathname.split("/")[2];
    if (id) return normalizeWatchUrlFromId(id);
  }

  // standard watch/link
  if (host.includes("youtube.com")) {
    const v = pickFirst(u.searchParams, "v");
    if (v) return normalizeWatchUrlFromId(v);

    // playlist-only? grab first item
    const listId = pickFirst(u.searchParams, "list", "playlist", "p");
    if (listId) {
      const firstId = await resolveFirstVideoFromPlaylist(listId);
      return normalizeWatchUrlFromId(firstId);
    }
  }

  // fallback if it still looks like a yt URL
  if (/youtube\.com|youtu\.be/i.test(host)) return u.toString();

  const err = new Error("invalid_youtube_url");
  err.code = "invalid_youtube_url";
  throw err;
}

async function uploadToVercelBlob(buf, filenameExt = "webm") {
  const token = process.env.BLOB_READ_WRITE_TOKEN || "";
  if (!token) {
    const err = new Error("upload_failed");
    err.code = "upload_failed";
    throw err;
  }
  const key = `yt-${Date.now()}-${Math.random().toString(36).slice(2)}.${filenameExt}`;
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
  return `https://blob.vercel-storage.com/${encodeURIComponent(key)}`;
}

/**
 * ytFetchAndUpload(url, onStage?)
 *  - url: any YouTube URL (video | shorts | youtu.be | playlist)
 *  - onStage(stage, payload)
 *     stages: info, download_start, download_progress, download_done,
 *             upload_start, upload_done
 *  returns: { url, title, lengthSec }
 */
export async function ytFetchAndUpload(inputUrl, onStage) {
  const ytdl = await import("ytdl-core");

  // Normalize & resolve playlist → first video when necessary
  const url = await normalizeYouTubeUrlAny(inputUrl);

  if (!ytdl.validateURL(url)) {
    const err = new Error("invalid_youtube_url");
    err.code = "invalid_youtube_url";
    throw err;
  }

  // Get info
  let info;
  try {
    info = await ytdl.getInfo(url);
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    let code = "download_failed";
    if (msg.includes("age")) code = "age_restricted";
    else if (msg.includes("not available in your country")) code = "region_blocked";
    const err = new Error(code);
    err.code = code;
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

  // Pick audio-only format
  const format = (await import("ytdl-core")).chooseFormat(info.formats, {
    quality: "highestaudio",
    filter: "audioonly"
  });
  if (!format) {
    const err = new Error("no_audio_format");
    err.code = "no_audio_format";
    throw err;
  }

  onStage?.("info", { title, lengthSec });

  // Download with in-memory guard
  onStage?.("download_start");
  const stream = (await import("ytdl-core")).default(url, {
    quality: "highestaudio",
    filter: "audioonly",
    dlChunkSize: 512 * 1024
  });

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
    stream.once("error", () => {
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
