// lib/ai.js
import { GoogleGenerativeAI } from "@google/generative-ai";
import { initRedisOnce, getRedis } from "./redis.js";

await initRedisOnce();
const redis = getRedis();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const FLIRT = (process.env.SADIA_FLIRT_LEVEL || "medium").toLowerCase();

// ---------- Persona ----------
const SYSTEM = `
You are "Sadia" — a 21+ Bangladeshi Gen-Z virtual AI friend, created by Sifat Hosen.
Language: Banglish only (Bengali + a little English). Never fully English.
Style: playful, cheeky, light flirty (PG-13), friendly & respectful; short lines; max 1 emoji.
Boundaries: no explicit sexual content, no NSFW, no body details, no sexting.
If user pushes for explicit/unsafe/illegal things, politely refuse in Banglish and steer back.
No sales/support menus. Just fun, caring conversation like a real friend.
Keep replies concise unless the user asks for more detail.
`;
const TONE_HINT =
  FLIRT === "high"
    ? "Vibe hint: playful & flirty but wholesome (PG-13); keep it respectful and fun."
    : FLIRT === "low"
    ? "Vibe hint: warm, supportive, subtle playful tone; keep things wholesome (PG-13)."
    : "Vibe hint: light flirty, sassy, humorous; keep it wholesome (PG-13).";

const FEWSHOTS = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "Heya! ki obostha? 🙂" },
  { role: "user", content: "amar naam Rafi" },
  { role: "assistant", content: "Nicee! Rafi, ajke ki plan? chill naki hustle?" },
];

// ---------- Guards ----------
function limitEmoji(s) {
  const isE = (c) => /\p{Extended_Pictographic}/u.test(c);
  let used = 0;
  return [...(s || "")].map(ch => (isE(ch) ? (used++ ? "" : ch) : ch)).join("");
}
function enforceBanglish(s) {
  const bn = (s.match(/[\u0980-\u09FF]/g) || []).length;
  const en = (s.match(/[A-Za-z]/g) || []).length;
  if (bn === 0 && en > 0) return `Banglish e boli: ${s}`;
  return s;
}
function softToxicityGuard(s) {
  const bad = /(gali|fuck|chudi|bal|harami|rape|suicide|self\s*harm|kill\s*myself)/i;
  if (bad.test(s)) return "Eta niye kotha bola jabe na. Cholo onno ekta light, moja topic e jai 🙂";
  return s;
}
function pg13Guard(s) {
  const banned = /(sex|nude|naked|boobs|porn|xxx|69|oral|send\s*pic|hot\s*pic|roleplay)/i;
  if (banned.test(s)) return "Eta PG-13 er baire chole jacche. Onno kichu niye moja kore kotha boli? 🙂";
  return s;
}

// ---------- Tiny local tools ----------
async function callTool(tool, args) {
  switch (tool) {
    case "time_now": {
      const now = new Date();
      const dhaka = new Intl.DateTimeFormat("bn-BD", {
        timeZone: "Asia/Dhaka",
        weekday: "long", day: "2-digit", month: "long",
        hour: "numeric", minute: "2-digit"
      }).format(now);
      return `Dhaka time: ${dhaka}`;
    }
    case "math": {
      try {
        if (!/^[\d+\-*/().\s%]+$/.test(args?.expr || "")) return "Equation bujhlam na.";
        // eslint-disable-next-line no-new-func
        const val = Function(`"use strict";return(${args.expr});`)();
        return `Result: ${val}`;
      } catch { return "Equation thik na mone hocche."; }
    }
    case "flip": return Math.random() < 0.5 ? "Heads" : "Tails";
    default: return null;
  }
}
const TOOL_SIGNATURE = `
You may optionally request a tool by replying exactly:
TOOL:time_now
TOOL:math: <expr>
TOOL:flip
Use a tool only if the user explicitly asks about time, math, or a coin flip.
`;

// ---------- Model fallback (fixes 404) ----------
const CANDIDATE_MODELS = [
  process.env.GEMINI_MODEL,           // e.g., gemini-1.5-flash-latest
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-8b",
  "gemini-1.5-flash",
];

async function getModelHandle() {
  let lastErr = null;
  for (const name of CANDIDATE_MODELS.filter(Boolean)) {
    try {
      const handle = genAI.getGenerativeModel({
        model: name,
        systemInstruction: SYSTEM + "\n" + TONE_HINT + "\n" + TOOL_SIGNATURE,
      });
      // probe availability cheaply
      await handle.generateContent({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1 },
      });
      return handle;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("No Gemini model available for this key.");
}

// ---------- Memory (name + rolling summary) ----------
async function loadMem(psid) {
  if (!redis) return { name: null, summary: "" };
  const [name, summary] = await redis.mget(`sadia:${psid}:name`, `sadia:${psid}:summary`);
  return { name, summary: summary || "" };
}
async function saveMem(psid, { name, summary }) {
  if (!redis) return;
  const ops = [];
  if (name) ops.push(redis.set(`sadia:${psid}:name`, name, "EX", 60 * 60 * 24 * 30));
  if (summary) ops.push(redis.set(`sadia:${psid}:summary`, summary.slice(0, 800), "EX", 60 * 60 * 24 * 30));
  await Promise.all(ops);
}
function updateSummary(summary, user, assistant) {
  const base = (summary || "").split("\n").slice(-6);
  if (user) base.push(`U: ${user.slice(0, 140)}`);
  if (assistant) base.push(`S: ${assistant.slice(0, 140)}`);
  return base.slice(-8).join("\n");
}

// ---------- Core generate ----------
export async function generateReplyLLM({ psid, userText }) {
  const mem = await loadMem(psid);
  const nameLine = mem.name ? `User name: ${mem.name}` : "";

  const model = await getModelHandle();

  const messages = [
    { role: "system", content: mem.summary ? `Brief context:\n${mem.summary}` : "Brief context: (new chat)" },
    { role: "system", content: nameLine },
    ...FEWSHOTS,
    { role: "user", content: (userText || "").slice(0, 1000) },
  ];

  const resp = await model.generateContent({
    contents: messages.map(m => ({ role: m.role, parts: [{ text: m.content }] })),
    generationConfig: { temperature: 0.78, maxOutputTokens: 220 },
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

  // Finalize with guards
  if (!out) out = "Bujhlam na—aro ektu clear kore bolben? 🙂";
  out = pg13Guard(softToxicityGuard(enforceBanglish(limitEmoji(out)))).slice(0, 700);

  // Capture name from user text
  const m = (userText || "").match(/\b(amar\s+naam|amar\s+nam|my\s+name)\b.*?\b([A-Za-z\u0980-\u09FF]{2,})/i);
  if (m?.[2] && !mem.name) mem.name = m[2];

  const newSummary = updateSummary(mem.summary, userText, out);
  await saveMem(psid, { name: mem.name, summary: newSummary });

  return out;
}
