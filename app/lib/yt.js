// lib/yt.js
// Modern YouTube → audio uploader using youtubei.js (Innertube) with ytdl-core fallback
// npm i youtubei.js ytdl-core
// Requires: BLOB_READ_WRITE_TOKEN for Vercel Blob uploads

const MAX_SECONDS = 12 * 60;            // 12 minutes
const MAX_BYTES   = 24 * 1024 * 1024;   // ~24 MB safe for Messenger

let _innertube = null;

async function getYT() {
  if (_innertube) return _innertube;
  const { Innertube, UniversalCache } = await import('youtubei.js');
  // Use English to simplify parsing; cookie is optional but helps with age/region gates
  _innertube = await Innertube.create({
    cache: new UniversalCache(true),
    retrieve_player: true,
    generate_session_locally: true,
    gl: 'US',
    hl: 'en',
    // supply cookie only if provided
    ...(process.env.YOUTUBE_COOKIE ? { cookie: process.env.YOUTUBE_COOKIE } : {})
  });
  return _innertube;
}

function normalizeWatchUrlFromId(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
function pickFirst(paramMap, ...names) {
  for (const n of names) if (paramMap.get(n)) return paramMap.get(n);
  return null;
}

// Resolve first video ID from a playlist page (no external libs)
async function resolveFirstVideoFromPlaylist(listId) {
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}&hl=en`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  if (!res.ok) throw Object.assign(new Error("playlist_fetch_failed"), { code: "playlist_fetch_failed" });
  const html = await res.text();

  // Grab first playlist item’s videoId quickly
  const m = html.match(/"playlistVideoRenderer"\s*:\s*\{[^}]*"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
  if (m?.[1]) return m[1];
  const m2 = html.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
  if (m2?.[1]) return m2[1];

  throw Object.assign(new Error("playlist_first_failed"), { code: "playlist_first_failed" });
}

/**
 * normalizeYouTubeUrlAny(input)
 *  - Accepts: watch/shorts/youtu.be/playlist links (with si, t, etc.)
 *  - Playlist-only → resolves to first video ID
 *  - Returns normalized watch URL
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

  // standard link
  if (host.includes("youtube.com")) {
    const v = pickFirst(u.searchParams, "v");
    if (v) return normalizeWatchUrlFromId(v);

    const listId = pickFirst(u.searchParams, "list", "playlist", "p");
    if (listId) {
      const firstId = await resolveFirstVideoFromPlaylist(listId);
      return normalizeWatchUrlFromId(firstId);
    }
  }

  // Looks like YT anyway; let downstream try
  if (/youtube\.com|youtu\.be/i.test(host)) return u.toString();

  const err = new Error("invalid_youtube_url");
  err.code = "invalid_youtube_url";
  throw err;
}

async function uploadToVercelBlob(buf, ext = "webm") {
  const token = process.env.BLOB_READ_WRITE_TOKEN || "";
  if (!token) {
    const err = new Error("upload_failed");
    err.code = "upload_failed";
    throw err;
  }
  const key = `yt-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
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

// --------- Core download via youtubei.js (primary) ----------
async function downloadViaInnertube(url, onStage) {
  const yt = await getYT();
  let info;
  try {
    info = await yt.getInfo(url);
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    // Bubble up so caller can try fallback
    const err = new Error(
      msg.includes('sign in') || msg.includes('age') ? 'age_restricted' :
      msg.includes('unavailable') || msg.includes('not available') ? 'region_blocked' :
      'download_failed'
    );
    err.code = err.message;
    throw err;
  }

  const basic = info?.basic_info || {};
  const title = basic.title || "Unknown title";
  const lengthSec = Number(basic.duration || 0);

  if (!Number.isFinite(lengthSec) || lengthSec <= 0) {
    const err = new Error("download_failed"); err.code = "download_failed"; throw err;
  }
  if (lengthSec > MAX_SECONDS) {
    const err = new Error("too_long"); err.code = "too_long"; throw err;
  }

  onStage?.("info", { title, lengthSec });

  // Request audio stream (prefers M4A; falls back to Opus)
  // youtubei.js exposes info.download({ type: 'audio', quality: 'best' })
  onStage?.("download_start");
  let stream;
  try {
    stream = await info.download({ type: 'audio', quality: 'best' });
  } catch {
    const err = new Error("no_audio_format"); err.code = "no_audio_format"; throw err;
  }

  let received = 0;
  const chunks = [];
  let ext = "webm"; // default
  // youtubei.js exposes streaming_data; try to guess container
  const adaptive = info?.streaming_data?.adaptive_formats || [];
  const picked = adaptive.find(f => f.has_audio && !f.has_video) || null;
  if (picked?.mime_type?.includes('audio/mp4')) ext = 'm4a';

  await new Promise((resolve, reject) => {
    stream.on('data', (c) => {
      received += c.length;
      if (received > MAX_BYTES) {
        const err = new Error("file_too_large"); err.code = "file_too_large";
        stream.destroy(err); return;
      }
      chunks.push(c);
      if (received % (1024 * 1024) < c.length) {
        const mb = Math.round(received / (1024 * 1024));
        onStage?.("download_progress", { mb });
      }
    });
    stream.on('end', resolve);
    stream.on('error', () => reject(Object.assign(new Error("download_failed"), { code: "download_failed" })));
  });

  onStage?.("download_done");
  const buf = Buffer.concat(chunks);

  onStage?.("upload_start");
  const publicUrl = await uploadToVercelBlob(buf, ext);
  onStage?.("upload_done");

  return { url: publicUrl, title, lengthSec };
}

// --------- Fallback via ytdl-core ----------
async function downloadViaYTDL(url, onStage) {
  const ytdl = await import('ytdl-core');
  if (!ytdl.validateURL(url)) {
    const err = new Error("invalid_youtube_url"); err.code = "invalid_youtube_url"; throw err;
  }
  let info;
  try {
    info = await ytdl.getInfo(url);
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    const err = new Error(
      msg.includes('age') ? 'age_restricted' :
      msg.includes('not available in your country') ? 'region_blocked' :
      'download_failed'
    );
    err.code = err.message;
    throw err;
  }
  const title = info.videoDetails?.title || "Unknown title";
  const lengthSec = Number(info.videoDetails?.lengthSeconds || 0);
  if (!Number.isFinite(lengthSec) || lengthSec <= 0) throw Object.assign(new Error("download_failed"), { code: "download_failed" });
  if (lengthSec > MAX_SECONDS) throw Object.assign(new Error("too_long"), { code: "too_long" });

  onStage?.("info", { title, lengthSec });

  const format = (await import('ytdl-core')).chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
  if (!format) throw Object.assign(new Error("no_audio_format"), { code: "no_audio_format" });

  onStage?.("download_start");
  const stream = (await import('ytdl-core')).default(url, {
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
        const err = new Error("file_too_large"); err.code = "file_too_large";
        stream.destroy(err); return;
      }
      chunks.push(c);
      if (received % (1024 * 1024) < c.length) {
        const mb = Math.round(received / (1024 * 1024));
        onStage?.("download_progress", { mb });
      }
    });
    stream.once("end", resolve);
    stream.once("error", () => reject(Object.assign(new Error("download_failed"), { code: "download_failed" })));
  });

  onStage?.("download_done");
  const buf = Buffer.concat(chunks);

  onStage?.("upload_start");
  const publicUrl = await uploadToVercelBlob(buf, ext);
  onStage?.("upload_done");

  return { url: publicUrl, title, lengthSec };
}

/**
 * Public: fetch, convert and upload
 *  - Handles playlists (first item), normalize any URL
 *  - Tries youtubei.js first, falls back to ytdl-core
 */
export async function ytFetchAndUpload(inputUrl, onStage) {
  const url = await normalizeYouTubeUrlAny(inputUrl);
  try {
    return await downloadViaInnertube(url, onStage);
  } catch (e) {
    // If innertube fails for some reason, try ytdl as a fallback
    try {
      return await downloadViaYTDL(url, onStage);
    } catch (e2) {
      // bubble a clean code upward
      const code = e2?.code || e?.code || "download_failed";
      const err = new Error(code);
      err.code = code;
      throw err;
    }
  }
}
