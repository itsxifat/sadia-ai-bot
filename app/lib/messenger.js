// lib/messenger.js
const PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN;

export async function sendText(psid, text) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: psid }, message: { text } }),
    cache: "no-store",
  });
  if (!res.ok) console.error("SendAPI error", res.status, await res.text());
}

export async function sendTyping(psid, on = true) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: psid }, sender_action: on ? "typing_on" : "typing_off" }),
    cache: "no-store",
  });
}
