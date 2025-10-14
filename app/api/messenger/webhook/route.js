// app/api/messenger/webhook/route.js
/* 
  This route handles:
  - GET: Webhook verification (hub.challenge)
  - POST: Incoming messages from Messenger
*/

const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN;
const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;
// const APP_SECRET = process.env.MESSENGER_APP_SECRET; // optional signature verify

// --- Helpers ---------------------------------------------------------------
async function fbSend(body) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Next.js fetch is fine for server environment
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("SendAPI error:", res.status, txt);
  }
}

async function sendTyping(psid, on = true) {
  return fbSend({
    recipient: { id: psid },
    sender_action: on ? "typing_on" : "typing_off",
  });
}

async function sendText(psid, text) {
  return fbSend({
    recipient: { id: psid },
    message: { text },
  });
}

// Simple “brain” for now (swap with your LLM later)
async function generateReply(userText) {
  if (/^\s*hi|hello|hey\b/i.test(userText)) {
    return "Hey! 👋 How can I help today?";
  }
  if (/help|support/i.test(userText)) {
    return "Sure—tell me what you need help with. You can try: Pricing, Demo, or Talk to human.";
  }
  return `You said: “${userText}”. Tell me more?`;
}

// --- Route handlers --------------------------------------------------------

// Verify webhook (Meta calls this once when you save your Callback URL)
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

// Receive webhook events
export async function POST(request) {
  try {
    const body = await request.json();

    if (body.object === "page") {
      for (const entry of body.entry || []) {
        for (const evt of entry.messaging || []) {
          const psid = evt.sender?.id;

          // Only handle simple text messages for now
          if (psid && evt.message?.text) {
            const text = evt.message.text.slice(0, 2000); // keep it safe
            await sendTyping(psid, true);
            const reply = await generateReply(text);
            await sendText(psid, reply);
            await sendTyping(psid, false);
          }

          // You can also handle postbacks:
          // if (psid && evt.postback) { ... }
        }
      }
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    return new Response("Not a page object", { status: 404 });
  } catch (e) {
    console.error("Webhook POST error:", e);
    return new Response("Bad Request", { status: 400 });
  }
}

// (Optional) If you implement X-Hub-Signature verification, you’ll need the raw body.
// With App Router this is doable, but keep it off initially for simplicity.
