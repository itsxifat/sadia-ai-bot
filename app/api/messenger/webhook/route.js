// app/api/messenger/webhook/route.js
import { generateReplyLLM } from "../../../lib/ai.js"; // <-- keep .js and relative path

export const runtime = "nodejs"; // ensure Node runtime on Vercel

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;

// Guard: fail fast if token missing (shows up in logs)
function assertEnv() {
  if (!PAGE_TOKEN || !VERIFY_TOKEN) {
    console.error("Missing Messenger env vars");
  }
}
assertEnv();

// Ignore Messenger's "echo" messages (messages sent by the Page itself)
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
  if (!res.ok) {
    const err = await res.text();
    console.error("SendAPI error:", res.status, err, "BODY:", JSON.stringify(body));
  }
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

// Webhook verify
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return new Response(challenge, { status: 200 });
  return new Response("Forbidden", { status: 403 });
}

// Webhook receive
export async function POST(request) {
  try {
    const body = await request.json();
    if (body.object !== "page") return new Response("Not a page object", { status: 404 });

    for (const entry of body.entry || []) {
      for (const evt of entry.messaging || []) {
        if (isEcho(evt)) continue; // avoid infinite loops

        const psid = evt.sender?.id;
        const textIn = evt.message?.text?.trim();
        if (!psid || !textIn) continue;

        // reply
        await sendTyping(psid, true);
        const reply = await generateReplyLLM({ psid, userText: textIn });
        await humanPause(reply);
        await sendText(psid, reply);
        await sendTyping(psid, false);
      }
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (e) {
    console.error("Webhook POST error:", e);
    return new Response("Bad Request", { status: 400 });
  }
}
