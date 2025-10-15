// app/lib/yt.js
import ytdl from "ytdl-core";
import { put } from "@vercel/blob";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_SECONDS = 8 * 60;          // 8 minutes
const MAX_BYTES   = 20 * 1024 * 1024; // 20 MB

/**
 * onStage: (stage, payload?) => void
 * Stages: "info", "download_start", "download_progress", "download_done",
 *         "upload_start", "upload_done"
 */
export async function ytFetchAndUpload(youtubeUrl, onStage) {
  const stage = (s, p) => { try { onStage && onStage(s, p); } catch {} };

  if (!ytdl.validateURL(youtubeUrl)) {
    throw new Error("invalid_youtube_url");
  }

  const info = await ytdl.getInfo(youtubeUrl);
  const title = (info?.videoDetails?.title || "audio").slice(0, 100);
  const lengthSec = parseInt(info?.videoDetails?.lengthSeconds || "0", 10);

  stage("info", { title, lengthSec });

  if (lengthSec > MAX_SECONDS) {
    throw new Error("too_long");
  }

  const format =
    ytdl.chooseFormat(info.formats, {
      quality: "highestaudio",
      filter: (f) =>
        f.hasAudio &&
        !f.hasVideo &&
        (f.container === "mp4" || f.container === "m4a" || f.mimeType?.includes("mp4")),
    }) ||
    ytdl.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" });

  if (!format) throw new Error("no_audio_format");

  const ext = format.container === "webm" ? "webm" : format.container || "m4a";
  const contentType = ext === "webm" ? "audio/webm" : "audio/mp4";
  const filename = `${randomUUID()}.${ext}`;
  const tmpPath = path.join("/tmp", filename);

  stage("download_start");

  let written = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    const stream = ytdl.downloadFromInfo(info, { format });

    let lastEmit = 0;
    stream.on("data", (chunk) => {
      written += chunk.length;
      if (written > MAX_BYTES) {
        stream.destroy(new Error("file_too_large"));
      }
      // throttle progress emits to every ~1s
      const now = Date.now();
      if (now - lastEmit > 1000) {
        lastEmit = now;
        stage("download_progress", { bytes: written, mb: (written / (1024 * 1024)).toFixed(1) });
      }
    });

    stream.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    stream.pipe(out);
  });

  stage("download_done", { bytes: written });

  // Upload to Vercel Blob
  stage("upload_start");
  const data = await fs.promises.readFile(tmpPath);
  const blob = await put(`yt/${filename}`, data, {
    access: "public",
    contentType,
    addRandomSuffix: false,
  });

  stage("upload_done", { url: blob.url });

  // cleanup
  fs.promises.unlink(tmpPath).catch(() => {});

  return { url: blob.url, title, lengthSec, contentType };
}
