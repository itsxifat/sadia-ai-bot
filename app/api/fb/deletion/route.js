// app/api/fb/deletion/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { parseFacebookSignedRequest } from "../../../../lib/fb-signed.js";
import { usersCol } from "../../../../lib/mongo.js"; // you already have this

const APP_SECRET = process.env.FB_APP_SECRET || "";
const BASE_URL   = process.env.PUBLIC_BASE_URL || "https://example.com";

/**
 * Facebook will POST application/x-www-form-urlencoded with:
 *   - signed_request=<...>
 * The payload contains at least { user_id: "<facebook_user_id>" }.
 *
 * Your response MUST be JSON:
 *   { "url": "<status url>", "confirmation_code": "<code>" }
 */
export async function POST(req) {
  try {
    const bodyText = await req.text();
    const params = new URLSearchParams(bodyText);
    const sr = params.get("signed_request");

    const { ok, data, error } = parseFacebookSignedRequest(sr, APP_SECRET);
    if (!ok) {
      console.warn("[FB deletion] invalid signed_request:", error);
      return Response.json({ error: "invalid_signed_request" }, { status: 400 });
    }

    const fbUserId = data?.user_id || data?.uid || null;
    if (!fbUserId) {
      console.warn("[FB deletion] user_id missing in payload");
      return Response.json({ error: "user_id_missing" }, { status: 400 });
    }

    // Do your deletion/anonymisation. Example: wipe the user row linked by fbUserId.
    const col = await usersCol();

    // If you keep PSID-only records, you can anonymize instead of delete.
    // Here we *delete* any docs that were linked via fbUserId.
    const res = await col.deleteMany({ fbUserId });

    // Generate a human-readable confirmation code
    const confirmation_code = `del_${fbUserId}_${Date.now()}`;

    console.log(`[FB deletion] deleted ${res.deletedCount} record(s) for fbUserId=${fbUserId} code=${confirmation_code}`);

    // You can persist a simple log if you want (optional):
    // await col.db.collection("deletion_logs").insertOne({ fbUserId, confirmation_code, at: new Date(), deleted: res.deletedCount });

    // Return the status URL + code (required by Facebook)
    const statusUrl = `${BASE_URL.replace(/\/+$/,"")}/deletion-status?code=${encodeURIComponent(confirmation_code)}`;
    return Response.json({ url: statusUrl, confirmation_code });
  } catch (e) {
    console.error("[FB deletion] server error", e);
    return Response.json({ error: "server_error" }, { status: 500 });
  }
}

// (Optional) allow GET for manual tests
export async function GET() {
  return new Response("OK", { status: 200 });
}
