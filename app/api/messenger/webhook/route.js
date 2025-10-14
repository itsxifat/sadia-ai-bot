// app/api/messenger/webhook/route.js
import { generateReplyLLM } from "@/lib/ai";

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;

// Simple in-memory store (swap to Redis/DB in prod)
const userMemory = new Map(); // psid -> { name?, greeted?, lastSeenAt }

async function fbSend(body) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error("SendAPI error:", res.status, await res.text());
}

async function sendTyping(psid, on = true) {
  return fbSend({ recipient: { id: psid }, sender_action: on ? "typing_on" : "typing_off" });
}
async function sendText(psid, text) {
  return fbSend({ recipient: { id: psid }, message: { text } });
}
async function sendQuickReplies(psid, text, replies) {
  return fbSend({
    recipient: { id: psid },
    message: {
      text,
      quick_replies: replies.map(r => ({
        content_type: "text",
        title: r.title,
        payload: r.payload || r.title.toUpperCase().replace(/\s+/g, "_"),
      })),
    },
  });
}

// “Human-like” pause
async function humanPause(text) {
  const wpm = 30;
  const words = (text || "").split(/\s+/).length;
  const ms = Math.min(2200, Math.max(500, (words / wpm) * 60000));
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

        // Only handle text messages here
        if (psid && evt.message?.text) {
          const textIn = evt.message.text.slice(0, 2000).trim();
          const mem = userMemory.get(psid) || { greeted: false };
          mem.lastSeenAt = Date.now();

          // Naive “name” capture (e.g., "amar naam Sifat" / "my name Sifat")
          const nameMatch = textIn.match(/\b(naam|name)\b.*?\b([A-Za-z\u0980-\u09FF]{2,})/i);
          if (nameMatch && nameMatch[2]) mem.name = nameMatch[2];

          userMemory.set(psid, mem);

          // First-time greeting
          if (!mem.greeted) {
            mem.greeted = true;
            userMemory.set(psid, mem);
            await sendTyping(psid, true);
            const intro =
              `Heya! Ami **Sadia**—Sifat Hosen er toiri ekta virtual AI bot. ` +
              `Banglish e kotha boli. Ki niye help chai? 🙂`;
            await humanPause(intro);
            await sendText(psid, intro);
            await sendTyping(psid, false);

            // Show quick options
            await sendQuickReplies(psid, "Nicher options theke choose korte paro:", [
              { title: "Pricing" },
              { title: "Services" },
              { title: "Talk to human" },
            ]);
            continue; // next event
          }

          // Normal AI reply
          await sendTyping(psid, true);
          const reply = await generateReplyLLM(textIn, mem);
          await humanPause(reply);
          await sendText(psid, reply);
          await sendTyping(psid, false);
        }

        // Handle quick replies/postbacks later if needed
      }
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (e) {
    console.error("Webhook POST error:", e);
    return new Response("Bad Request", { status: 400 });
  }
}
