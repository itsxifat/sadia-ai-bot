// lib/yt.js
// Robust YouTube → audio uploader for Messenger
// Requires: npm i ytdl-core ytpl
// Also set: BLOB_READ_WRITE_TOKEN (Vercel Blob R/W token)

const MAX_SECONDS = 12 * 60;            // 12 minutes
const MAX_BYTES   = 24 * 1024 * 1024;   // ~24 MB for safety

function normalizeWatchUrlFromId(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function pickFirst(paramMap, ...names) {
  for (const n of names) {
    if (paramMap.get(n)) return paramMap.get(n);
  }
  return null;
}

/**
 * normalizeYouTubeUrlAny(input)
 *  - Accepts: shorts, youtu.be, watch URLs, “si” params, timestamps, etc.
 *  - If a playlist-only URL is provided, resolves to the **first video** in the playlist.
 *  - Returns a normal watch URL.
 *  - Throws coded errors on invalid URLs or unresolvable playlists.
 */
export async function normalizeYouTubeUrlAny(input) {
  const ytpl = (await import("ytpl")).default;

  let u;
  try {
    u = new URL(input);
  } catch {
    const err = new Error("invalid_youtube_url");
    err.code = "invalid_youtube_url";
    throw err;
  }
  const host = u.hostname.toLowerCase();

  // handle youtu.be/<id>
  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\/+/, ""); // after slash
    if (id) return normalizeWatchUrlFromId(id);
  }

  // shorts → watch
  if (host.includes("youtube.com") && u.pathname.startsWith("/shorts/")) {
    const id = u.pathname.split("/")[2];
    if (id) return normalizeWatchUrlFromId(id);
  }

  // standard watch link: pick v= if present
  if (host.includes("youtube.com")) {
    const v = pickFirst(u.searchParams, "v");
    if (v) return normalizeWatchUrlFromId(v);

    // playlist only? → resolve first item using ytpl
    const listId = pickFirst(u.searchParams, "list", "playlist", "p");
    if (listId) {
      try {
        // ytpl returns items in order; pageSize=1 gets just the first
        const pl = await ytpl(listId, { pages: 1 });
        const first = pl?.items?.[0]?.id;
        if (first) return normalizeWatchUrlFromId(first);
      } catch (e) {
        // fall through to coded error
      }
      const err = new Error("playlist_first_failed");
      err.code = "playlist_first_failed";
      throw err;
    }
  }

  // if we get here and still no watch form, try returning raw if it’s a plausible yt URL
  if (/youtube\.com|youtu\.be/i.test(u.hostname)) {
    return u.toString();
  }

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
 *  - onStage: (stage, payload) => void
 *     stages: info, download_start, download_progress, download_done, upload_start, upload_done
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

  // Fetch info
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

  // Prefer audio-only formats
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

  // Download → buffer (guard with MAX_BYTES)
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
      // progress ping roughly each MB
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
