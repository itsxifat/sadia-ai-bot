// lib/sign.js
import crypto from "crypto";

const CLAIM_SECRET = process.env.CLAIM_SECRET || "dev-secret-change-me";

export function signPayload(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", CLAIM_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySignature(compact) {
  if (!compact || !compact.includes(".")) return null;
  const [payload, sig] = compact.split(".");
  const expect = crypto.createHmac("sha256", CLAIM_SECRET).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()); }
  catch { return null; }
}
