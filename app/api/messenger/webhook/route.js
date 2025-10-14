import { generateReplyLLM } from "../../../lib/ai";

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;

const fallbackMem = new Map(); // for first run without Redis (keeps history ephemeral)

async function fbSend(body) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) console.error("SendAPI error:", res.status, await res.text());
}
async function sendTyping(psid, on = true) {
  return fbSend({ recipient: { id: psid }, sender_action: on ? "typing_on" : "typing_off" });
}
async function sendText(psid, text) {
  return fbSend({ recipient: { id: psid }, message: { text } });
}
async function pause(text) {
  const wpm = 32, words = (text || "").split(/\s+/).length;
  const ms = Math.min(2400, Math.max(500, (words / wpm) * 60000));
  await new Promise(r => setTimeout(r, ms));
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === VERIFY_TOKEN) return new Response(challenge, { status: 200 });
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (body.object !== "page") return new Response("Not a page object", { status: 404 });

    for (const entry of body.entry || []) {
      for (const evt of entry.messaging || []) {
        const psid = evt.sender?.id;
        const textIn = evt.message?.text?.trim();
        if (!psid || !textIn) continue;

        // (Optional) ultra-short first greeting (one time, cached in memory)
        if (!fallbackMem.get(psid)) {
          fallbackMem.set(psid, 1);
          await sendTyping(psid, true);
          const intro = "Heya! Ami Sadia—just chill AI friend. 🙂";
          await pause(intro);
          await sendText(psid, intro);
          await sendTyping(psid, false);
          // don't continue; let it also answer user's first message below
        }

        await sendTyping(psid, true);
        const reply = await generateReplyLLM({ psid, userText: textIn });
        await pause(reply);
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
