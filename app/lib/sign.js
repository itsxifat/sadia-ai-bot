// app/lib/sign.js
import crypto from "crypto";

const CLAIM_SECRET = (process.env.CLAIM_SECRET || "dev-secret").slice(0, 64);

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

export function signPayload(obj, ttlSec = 10 * 60) {
  const payload = { ...obj, iat: Date.now(), exp: Date.now() + ttlSec * 1000 };
  const data = Buffer.from(JSON.stringify(payload));
  const sig  = crypto.createHmac("sha256", CLAIM_SECRET).update(data).digest();
  return `${b64url(sig)}.${b64url(data)}`;
}

export function verifySignature(token) {
  try {
    if (!token || !token.includes(".")) return null;
    const [sigPart, payloadPart] = token.split(".");
    const data = Buffer.from(payloadPart.replace(/-/g,"+").replace(/_/g,"/"), "base64");
    const expected = b64url(crypto.createHmac("sha256", CLAIM_SECRET).update(data).digest());
    if (expected !== sigPart) return null;
    const json = JSON.parse(data.toString("utf8"));
    if (json.exp && Date.now() > json.exp) return null;
    return json;
  } catch { return null; }
}
