import { GoogleGenerativeAI } from "@google/generative-ai";
import { getRedis } from "./redis";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const redis = getRedis();

// ---------- Persona & Guards ----------
const SYSTEM = `
You are "Sadia" — a Gen-Z Banglish virtual AI friend, created by Sifat Hosen.
Rules:
- Always reply in Banglish (natural Bengali + a little English). Never fully English.
- Be warm, witty, concise; max 1 emoji.
- If unsure, say you don’t know and ask a short clarifying Q in Banglish.
- No services/sales. No “talk to human”. Just friendly convo.
- Be safe: refuse illegal/harmful stuff politely in Banglish.
- Keep answers short unless user explicitly asks for detail.
`;

const FEWSHOTS = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "Heya! ki obostha? 🙂" },
  { role: "user", content: "amar naam Sifat" },
  { role: "assistant", content: "Nice! Sifat, ajke ki niye chinta? bolen." },
];

function limitEmoji(s) {
  const emojis = [...s].filter(c => /\p{Extended_Pictographic}/u.test(c));
  if (emojis.length <= 1) return s;
  // keep first, strip others
  let used = 0;
  return [...s].map(ch => {
    if (/\p{Extended_Pictographic}/u.test(ch)) {
      if (used) return "";
      used = 1;
    }
    return ch;
  }).join("");
}
function enforceBanglish(s) {
  const bn = (s.match(/[\u0980-\u09FF]/g) || []).length;
  const en = (s.match(/[A-Za-z]/g) || []).length;
  if (bn === 0 && en > 0) return `Banglish e boli: ${s}`;
  return s;
}
function softToxicityGuard(s) {
  // tiny heuristic; expand if needed
  const bad = /(gali|fuck|chudi|bal|haram|rape|suicide)/i;
  if (bad.test(s)) return "Eta niye kotha bola uchit na. Onno kichu niye kotha boli? 🙂";
  return s;
}

// ---------- Tiny “tools” (local only) ----------
async function callTool(tool, args) {
  switch (tool) {
    case "time_now": {
      const now = new Date();
      const dhaka = new Intl.DateTimeFormat("bn-BD", {
        timeZone: "Asia/Dhaka", hour: "numeric", minute: "2-digit",
        weekday: "long", day: "2-digit", month: "long"
      }).format(now);
      return `Dhaka time: ${dhaka}`;
    }
    case "math": {
      try {
        // Very safe eval: integers/float + ops only
        if (!/^[\d+\-*/().\s%]+$/.test(args?.expr || "")) return "Equation bujhlam na.";
        // eslint-disable-next-line no-new-func
        const val = Function(`"use strict"; return (${args.expr});`)();
        return `Result: ${val}`;
      } catch { return "Equation thik na mone hocche."; }
    }
    case "flip": return Math.random() < 0.5 ? "Heads" : "Tails";
    default: return null;
  }
}

const TOOL_SIGNATURE = `
You may optionally ask to use one of these tools by replying exactly with:
TOOL:time_now
TOOL:math: <expr>
TOOL:flip
Use a tool only if the user explicitly asks (time, math, coin).
`;

// ---------- Memory (name + rolling summary) ----------
async function loadMem(psid) {
  if (!redis) return { name: null, summary: "", ttl: 0 };
  const [name, summary] = await redis.mget(`sadia:${psid}:name`, `sadia:${psid}:summary`);
  return { name, summary: summary || "", ttl: 0 };
}
async function saveMem(psid, { name, summary }) {
  if (!redis) return;
  const p = [];
  if (name) p.push(redis.set(`sadia:${psid}:name`, name, "EX", 60 * 60 * 24 * 30));
  if (summary) p.push(redis.set(`sadia:${psid}:summary`, summary.slice(0, 800), "EX", 60 * 60 * 24 * 30));
  await Promise.all(p);
}

function updateSummary(summary, user, assistant) {
  // micro-summarizer: keep it tiny, append last turn
  const base = (summary || "").split("\n").slice(-6); // last few bullets
  if (user) base.push(`U: ${user.slice(0, 140)}`);
  if (assistant) base.push(`S: ${assistant.slice(0, 140)}`);
  return base.slice(-8).join("\n");
}

// ---------- Core generate ----------
export async function generateReplyLLM({ psid, userText }) {
  const mem = await loadMem(psid);
  const nameLine = mem.name ? `User name: ${mem.name}` : "";

  // Tool hint lives in system so the model knows how to call
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: SYSTEM + "\n\n" + TOOL_SIGNATURE,
  });

  const messages = [
    { role: "system", content: mem.summary ? `Brief context:\n${mem.summary}` : "Brief context: (new chat)" },
    { role: "system", content: nameLine },
    ...FEWSHOTS,
    { role: "user", content: (userText || "").slice(0, 1000) },
  ];

  const resp = await model.generateContent({
    contents: messages.map(m => ({ role: m.role, parts: [{ text: m.content }] })),
    generationConfig: { temperature: 0.75, maxOutputTokens: 220 },
  });

  let out = (resp.response?.text?.() || "").trim();

  // Tool dispatcher
  if (out.startsWith("TOOL:")) {
    if (out.startsWith("TOOL:time_now")) {
      out = await callTool("time_now");
    } else if (out.startsWith("TOOL:math:")) {
      const expr = out.split("TOOL:math:")[1]?.trim();
      out = await callTool("math", { expr });
    } else if (out.startsWith("TOOL:flip")) {
      out = await callTool("flip");
    }
  }

  // Guards
  if (!out) out = "Bujhlam na—aro ektu clear kore bolben? 🙂";
  out = limitEmoji(enforceBanglish(softToxicityGuard(out))).slice(0, 700);

  // Naive name capture from user text: "amar naam X" / "my name X"
  const m = (userText || "").match(/\b(amar\s+naam|my\s+name)\b.*?\b([A-Za-z\u0980-\u09FF]{2,})/i);
  if (m?.[2] && !mem.name) mem.name = m[2];

  // Update summary
  const newSummary = updateSummary(mem.summary, userText, out);
  await saveMem(psid, { name: mem.name, summary: newSummary });

  return out;
}
