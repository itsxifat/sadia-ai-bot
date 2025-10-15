// lib/yt.js
// Modern YouTube → audio uploader using youtubei.js (ANDROID client) with ytdl-core fallback.
// Works for watch/shorts/youtu.be/playlist (playlist = first item).
// Requires: BLOB_READ_WRITE_TOKEN (Vercel Blob RW token)

const MAX_SECONDS = 12 * 60;           // 12 minutes
const MAX_BYTES   = 24 * 1024 * 1024;  // ~24 MB (Messenger-friendly)

let _innertube = null;

const UA =
  process.env.YT_UA ||
  "Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

function err(code) { const e = new Error(code); e.code = code; return e; }

async function getYT() {
  if (_innertube) return _innertube;
  const { Innertube, UniversalCache } = await import('youtubei.js');

  _innertube = await Innertube.create({
    cache: new UniversalCache(true),
    retrieve_player: true,
    generate_session_locally: true,
    gl: 'US',
    hl: 'en',
    client_type: 'ANDROID',          // <-- more permissive
    client_version: '19.08.35',      // stable android version string
    ...(process.env.YOUTUBE_COOKIE ? { cookie: process.env.YOUTUBE_COOKIE } : {}),
    // attach UA on fetches (helps some edge blocks)
    fetch: (input, init={}) => {
      const headers = new Headers(init.headers || {});
      if (!headers.has('user-agent')) headers.set('user-agent', UA);
      if (process.env.YOUTUBE_COOKIE && !headers.has('cookie')) {
        headers.set('cookie', process.env.YOUTUBE_COOKIE);
      }
      return fetch(input, { ...init, headers });
    }
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

// Resolve first video from playlist HTML (no external lib)
async function resolveFirstVideoFromPlaylist(listId) {
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}&hl=en`;
  const res = await fetch(url, {
    headers: { "Accept-Language": "en", "User-Agent": UA, ...(process.env.YOUTUBE_COOKIE ? { Cookie: process.env.YOUTUBE_COOKIE } : {}) }
  });
  if (!res.ok) throw err("playlist_fetch_failed");
  const html = await res.text();

  const m = html.match(/"playlistVideoRenderer"\s*:\s*\{[^}]*"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/)
        || html.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
  if (m?.[1]) return m[1];
  throw err("playlist_first_failed");
}

/** Normalize any YT URL; playlist-only → first video */
export async function normalizeYouTubeUrlAny(input) {
  let u;
  try { u = new URL(input); } catch { throw err("invalid_youtube_url"); }
  const host = u.hostname.toLowerCase();

  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\/+/, "");
    if (id) return normalizeWatchUrlFromId(id);
  }
  if (host.includes("youtube.com") && u.pathname.startsWith("/shorts/")) {
    const id = u.pathname.split("/")[2];
    if (id) return normalizeWatchUrlFromId(id);
  }
  if (host.includes("youtube.com")) {
    const v = pickFirst(u.searchParams, "v");
    if (v) return normalizeWatchUrlFromId(v);
    const listId = pickFirst(u.searchParams, "list", "playlist", "p");
    if (listId) {
      const firstId = await resolveFirstVideoFromPlaylist(listId);
      return normalizeWatchUrlFromId(firstId);
    }
  }
  if (/youtube\.com|youtu\.be/i.test(host)) return u.toString();
  throw err("invalid_youtube_url");
}

async function uploadToVercelBlob(buf, ext = "webm") {
  const token = process.env.BLOB_READ_WRITE_TOKEN || "";
  if (!token) throw err("upload_failed");
  const key = `yt-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const endpoint = `https://blob.vercel-storage.com/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`;
  const res = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: buf
  });
  if (!res.ok) throw err("upload_failed");
  return `https://blob.vercel-storage.com/${encodeURIComponent(key)}`;
}

/* -------- Primary: youtubei.js (ANDROID) ---------- */
async function downloadViaInnertube(url, onStage) {
  const yt = await getYT();
  let info;
  try {
    info = await yt.getInfo(url);
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    if (msg.includes("sign in") || msg.includes("age")) throw err("age_restricted");
    if (msg.includes("unavailable") || msg.includes("not available")) throw err("region_blocked");
    throw err("download_failed");
  }

  const basic = info?.basic_info || {};
  const title = basic.title || "Unknown title";
  const lengthSec = Number(basic.duration || 0);
  if (!Number.isFinite(lengthSec) || lengthSec <= 0) throw err("download_failed");
  if (lengthSec > MAX_SECONDS) throw err("too_long");

  onStage?.("info", { title, lengthSec });

  // Prefer m4a if available; else opus/webm
  onStage?.("download_start");
  let stream;
  try {
    stream = await info.download({ type: 'audio', quality: 'best', format: 'mp4' /* hint m4a */ });
  } catch {
    // try generic audio
    stream = await info.download({ type: 'audio', quality: 'best' });
  }

  // guess extension
  const adaptive = info?.streaming_data?.adaptive_formats || [];
  const picked = adaptive.find(f => f.has_audio && !f.has_video) || null;
  let ext = 'webm';
  const mime = picked?.mime_type || '';
  if (/audio\/mp4/i.test(mime)) ext = 'm4a';

  let received = 0;
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', c => {
      received += c.length;
      if (received > MAX_BYTES) {
        stream.destroy(err("file_too_large"));
        return;
      }
      chunks.push(c);
      if (received % (1024 * 1024) < c.length) {
        onStage?.("download_progress", { mb: Math.round(received / (1024*1024)) });
      }
    });
    stream.on('end', resolve);
    stream.on('error', () => reject(err("download_failed")));
  });

  onStage?.("download_done");
  const buf = Buffer.concat(chunks);

  onStage?.("upload_start");
  const publicUrl = await uploadToVercelBlob(buf, ext);
  onStage?.("upload_done");

  return { url: publicUrl, title, lengthSec };
}

/* -------- Fallback: ytdl-core with UA & cookie ---------- */
async function downloadViaYTDL(url, onStage) {
  const ytdl = await import('ytdl-core');
  if (!ytdl.validateURL(url)) throw err("invalid_youtube_url");

  let info;
  try {
    info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'user-agent': UA,
          ...(process.env.YOUTUBE_COOKIE ? { cookie: process.env.YOUTUBE_COOKIE } : {})
        },
        maxRedirects: 5
      }
    });
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    if (msg.includes('age')) throw err('age_restricted');
    if (msg.includes('not available in your country')) throw err('region_blocked');
    throw err('download_failed');
  }

  const title = info.videoDetails?.title || "Unknown title";
  const lengthSec = Number(info.videoDetails?.lengthSeconds || 0);
  if (!Number.isFinite(lengthSec) || lengthSec <= 0) throw err("download_failed");
  if (lengthSec > MAX_SECONDS) throw err("too_long");

  onStage?.("info", { title, lengthSec });

  const format = (await import('ytdl-core')).chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
  if (!format) throw err("no_audio_format");

  const ext = /mp4|m4a/i.test(format.container || "") ? "m4a" : "webm";

  onStage?.("download_start");
  const stream = (await import('ytdl-core')).default(url, {
    quality: "highestaudio",
    filter: "audioonly",
    dlChunkSize: 512 * 1024,
    highWaterMark: 1 << 20,  // 1MB
    requestOptions: {
      headers: {
        'user-agent': UA,
        ...(process.env.YOUTUBE_COOKIE ? { cookie: process.env.YOUTUBE_COOKIE } : {})
      },
      maxRedirects: 5
    }
  });

  let received = 0;
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on("data", (c) => {
      received += c.length;
      if (received > MAX_BYTES) {
        stream.destroy(err("file_too_large")); return;
      }
      chunks.push(c);
      if (received % (1024*1024) < c.length) {
        onStage?.("download_progress", { mb: Math.round(received/(1024*1024)) });
      }
    });
    stream.once("end", resolve);
    stream.once("error", () => reject(err("download_failed")));
  });

  onStage?.("download_done");
  const buf = Buffer.concat(chunks);

  onStage?.("upload_start");
  const publicUrl = await uploadToVercelBlob(buf, ext);
  onStage?.("upload_done");

  return { url: publicUrl, title, lengthSec };
}

/** Public: normalize → try Innertube → fallback ytdl */
export async function ytFetchAndUpload(inputUrl, onStage) {
  const url = await normalizeYouTubeUrlAny(inputUrl);
  try {
    return await downloadViaInnertube(url, onStage);
  } catch (e1) {
    try {
      return await downloadViaYTDL(url, onStage);
    } catch (e2) {
      const code = e2?.code || e1?.code || "download_failed";
      const e = new Error(code); e.code = code; throw e;
    }
  }
}
