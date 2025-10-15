// lib/fb-signed.js
import crypto from "crypto";

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

/** Verifies and parses Facebook's signed_request using your App Secret */
export function parseFacebookSignedRequest(signedRequest, appSecret) {
  try {
    if (!signedRequest || !appSecret) return { ok:false, error:"missing_params" };
    const [sigPart, payloadPart] = signedRequest.split(".");
    if (!sigPart || !payloadPart) return { ok:false, error:"bad_format" };

    const expectedSig = b64urlEncode(
      crypto.createHmac("sha256", appSecret).update(payloadPart).digest()
    );

    // timing-safe compare if lengths equal
    const a = Buffer.from(expectedSig);
    const b = Buffer.from(sigPart);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok:false, error:"bad_signature" };
    }

    const json = JSON.parse(b64urlDecode(payloadPart).toString("utf8"));
    return { ok:true, data: json };
  } catch {
    return { ok:false, error:"parse_error" };
  }
}
