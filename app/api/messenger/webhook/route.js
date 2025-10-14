// app/api/messenger/webhook/route.js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { generateReplyLLM } from "../../../lib/ai.js";

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;

function log(...a){ console.log("[WEBHOOK]", ...a); }

function isEcho(evt) {
  return Boolean(evt.message?.is_echo);
}

async function fbSend(body) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const ok = res.ok;
  const txt = await res.text();
  if (!ok) console.error("[SendAPI error]", res.status, txt, "BODY:", JSON.stringify(body));
  else log("[SendAPI ok]", txt);
  return ok;
}

async function sendTyping(psid, on = true) {
  return fbSend({ recipient: { id: psid }, sender_action: on ? "typing_on" : "typing_off" });
}
async function sendText(psid, text) {
  return fbSend({ recipient: { id: psid }, message: { text } });
}
async function humanPause(text) {
  const wpm = 32;
  const ms = Math.min(2400, Math.max(500, ((text || "").split(/\s+/).length / wpm) * 60000));
  await new Promise(r => setTimeout(r, ms));
}

// VERIFY
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  log("GET verify", { mode, tokenOk: token === VERIFY_TOKEN });
  if (mode === "subscribe" && token === VERIFY_TOKEN) return new Response(challenge, { status: 200 });
  return new Response("Forbidden", { status: 403 });
}

// RECEIVE
export async function POST(req) {
  try {
    const body = await req.json();
    log("POST body.object", body.object);

    if (body.object !== "page") return new Response("Not a page object", { status: 404 });

    for (const entry of body.entry || []) {
      for (const evt of entry.messaging || []) {
        if (isEcho(evt)) { log("skip echo"); continue; }

        const psid = evt.sender?.id;
        const textIn = evt.message?.text?.trim();
        log("event", { psid, textIn });

        if (!psid || !textIn) continue;

        await sendTyping(psid, true);
        const reply = await generateReplyLLM({ psid, userText: textIn });
        log("reply", reply);
        await humanPause(reply);
        await sendText(psid, reply);
        await sendTyping(psid, false);
      }
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (e) {
    console.error("[WEBHOOK error]", e);
    return new Response("Bad Request", { status: 400 });
  }
}
