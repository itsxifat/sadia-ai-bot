// lib/sign.js
import crypto from "crypto";

const CLAIM_SECRET = process.env.CLAIM_SECRET || "dev-secret-change-me";

/** RFC4648 base64url helpers (no padding) */
function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(base64, "base64");
}

/** Constant-time compare that tolerates length mismatch without throwing */
function safeEqual(a, b) {
  const aBuf = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bBuf = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function signPayload(obj) {
  const payload = b64urlEncode(JSON.stringify(obj));
  const sig = b64urlEncode(
    crypto.createHmac("sha256", CLAIM_SECRET).update(payload).digest()
  );
  return `${payload}.${sig}`;
}

export function verifySignature(compact) {
  try {
    if (!compact || !compact.includes(".")) return null;
    const [payload, sig] = compact.split(".");
    const expect = b64urlEncode(
      crypto.createHmac("sha256", CLAIM_SECRET).update(payload).digest()
    );
    if (!safeEqual(expect, sig)) return null;
    const json = JSON.parse(b64urlDecode(payload).toString("utf8"));
    return json || null;
  } catch {
    return null;
  }
}
