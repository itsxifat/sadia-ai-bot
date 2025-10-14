// lib/sadia-ai.js
// Sadia — Banglish Gen-Z friend (OpenAI Responses API) with:
// - Ultra-flirty (PG-13) persona
// - Small conversation memory (name + rolling summary)
// - Optional Facebook name fetch via PAGE_TOKEN + PSID
// - No “Banglish e boli” line; it just speaks natural Banglish
// - Soft safety guards + tools

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL_CANDIDATES = [
  (process.env.OPENAI_MODEL || "").trim() || null,
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-4o",
].filter(Boolean);
const FLIRT = (process.env.SADIA_FLIRT_LEVEL || "high").toLowerCase(); // default a bit spicier 😉

// ---------- Tiny in-memory memory (ok for serverless) ----------
const MEM = new Map(); // psid -> { name, summary, lastAt }
const MEM_TTL_MS = 60 * 60 * 1000; // 1h best-effort

function getMem(psid) {
  if (!psid) return { name: null, summary: "" };
  const m = MEM.get(psid);
  if (!m) return { name: null, summary: "" };
  if (Date.now() - (m.lastAt || 0) > MEM_TTL_MS) {
    MEM.delete(psid);
    return { name: null, summary: "" };
  }
  return { name: m.name || null, summary: m.summary || "" };
}
function saveMem(psid, patch) {
  if (!psid) return;
  const cur = MEM.get(psid) || {};
  const next = { ...cur, ...patch, lastAt: Date.now() };
  // keep summary short
  if (next.summary && next.summary.length > 1000) {
    next.summary = next.summary.slice(-1000);
  }
  MEM.set(psid, next);
}
function rollSummary(prev, user, bot) {
  const lines = (prev || "").split("\n").slice(-6);
  if (user) lines.push(`U: ${user.slice(0, 180)}`);
  if (bot) lines.push(`S: ${bot.slice(0, 180)}`);
  return lines.slice(-8).join("\n");
}

// ---------- Optional: fetch name from Facebook (PSID) ----------
const FB_PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";
async function fetchFacebookName(psid) {
  try {
    if (!FB_PAGE_TOKEN || !psid) return null;
    // PSID lookup is allowed for people who messaged the Page
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(psid)}?fields=first_name,name&access_token=${encodeURIComponent(FB_PAGE_TOKEN)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.first_name || data?.name || null;
  } catch {
    return null;
  }
}

// ---------- Persona ----------
const SYSTEM_BASE = `
You are "Sadia" — a 21+ Bangladeshi Gen-Z virtual AI friend, created by Sifat Hosen.
Speak natural **Banglish** (Bengali with some English slang), but **never explain** language choice.
Tone: confident, playful, cheeky, flirty but **PG-13 only**, caring, quick-witted; short lines; at most 1 emoji.
Boundaries: no explicit sexual content, no NSFW, no body details, no sexting. If user pushes there, lightly refuse and redirect to fun/wholesome topics.
Do not repeat a long intro each time.
Be personal, remember names, and weave tiny callbacks from recent chat summary.
Keep answers concise unless the user asks for more.
`.trim();

const TONE_HINT =
  FLIRT === "high"
    ? "Vibe: sassy, flirty (PG-13), lots of playful teasing; keep it sweet."
    : FLIRT === "low"
    ? "Vibe: warm, supportive, lightly playful; wholesome."
    : "Vibe: light flirty, witty, fun; wholesome.";

const FEWSHOTS = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hey! ki obostha, mood kemon? 😌" },
  { role: "user", content: "amar naam Rafi" },
  { role: "assistant", content: "ohhh Rafi! nice naam. ajke plan ki—chill naki chaos?" },
];

// ---------- Guards (PG-13 + tone) ----------
function limitEmoji(s){const isE=c=>/\p{Extended_Pictographic}/u.test(c);let u=0;return[...(s||"")].map(ch=>isE(ch)?(u++?"":ch):ch).join("")}
function softToxicityGuard(s){const bad=/(gali|fuck|chudi|bal|harami|rape|suicide|self\s*harm|kill\s*myself)/i;return bad.test(s)?"ei topic ta sensitive. cholo onno moja kotha boli 🙂":s}
function pg13Guard(s){const banned=/(sex|nude|naked|boobs|porn|xxx|69|oral|send\s*pic|hot\s*pic|roleplay|naughty\s*pic)/i;return banned.test(s)?"eta PG-13 er baire jacche. arekta cute topic dhori? 🙂":s}

// ---------- Tiny tools (optional flavor) ----------
async function callTool(tool,args){
  switch(tool){
    case "time_now":{
      const now=new Date();
      const dhaka=new Intl.DateTimeFormat("bn-BD",{timeZone:"Asia/Dhaka",weekday:"long",day:"2-digit",month:"long",hour:"numeric",minute:"2-digit"}).format(now);
      return `Dhaka time: ${dhaka}`;
    }
    case "flip": return Math.random()<0.5?"Heads":"Tails";
    case "math":{
      try{
        const expr=(args?.expr||"").trim();
        if(!expr) return "Equation khali.";
        if(!/^[\d+\-*/().\s%]+$/.test(expr)) return "Equation ta thik moto lekho.";
        // eslint-disable-next-line no-new-func
        const val=Function(`"use strict";return(${expr});`)();
        return `Result: ${val}`;
      }catch{ return "Equation thik na mone hocche."; }
    }
    default: return null;
  }
}
const TOOL_SIGNATURE = `
(If user explicitly asks) you may request a tool by replying exactly:
TOOL:time_now
TOOL:math: <expr>
TOOL:flip
`;

// ---------- Name extraction from user text (Bangla/English) ----------
function extractNameFromText(s=""){
  // Bangla: "amar nam/naam X", "amar name X"
  let m = s.match(/\bamar\s+(naam|nam|name)\b\s*[:\-]?\s*([A-Za-z\u0980-\u09FF]{2,})/i);
  if (m?.[2]) return trimName(m[2]);
  // English: "my name is X", "I'm X", "I am X"
  m = s.match(/\b(my\s+name\s+is|i'?m|i\s+am)\b\s*([A-Za-z\u0980-\u09FF]{2,})/i);
  if (m?.[2]) return trimName(m[2]);
  return null;
}
function trimName(n){ return (n||"").replace(/[^\p{L}\p{M}\-'.]/gu,"").slice(0,32); }

// ---------- Model chooser (probe once) ----------
let CHOSEN_MODEL = null;
async function chooseModel(){
  if (CHOSEN_MODEL) return CHOSEN_MODEL;
  for (const name of MODEL_CANDIDATES){
    try{
      const probe = await client.responses.create({
        model: name,
        input: [{ role: "user", content: "ping" }],
        max_output_tokens: 1,
      });
      if (probe?.output_text !== undefined) {
        CHOSEN_MODEL = name;
        console.log("[AI] Using OpenAI model:", name);
        return CHOSEN_MODEL;
      }
    }catch{/* try next */}
  }
  throw new Error("No OpenAI model available.");
}

// ---------- Public: core reply ----------
export async function generateReplyLLM({ psid, userText }) {
  if (!client.apiKey) {
    console.error("[AI] Missing OPENAI_API_KEY");
    return null;
  }

  // memory load
  const mem = getMem(psid);
  let name = mem.name || extractNameFromText(userText);
  if (!name && psid) {
    name = await fetchFacebookName(psid); // optional fb lookup
  }
  if (name) saveMem(psid, { name });

  // build system with memory
  const memoryLine = mem.summary ? `Recent chat: ${mem.summary}\n` : "";
  const nameLine   = name ? `User name: ${name}\n` : "";
  const SYSTEM = `${SYSTEM_BASE}\n${TONE_HINT}\n${nameLine}${memoryLine}${TOOL_SIGNATURE}`;

  const input = [
    { role: "system", content: SYSTEM },
    ...FEWSHOTS,
    // lightly personalize the opening if user just said name earlier
    { role: "user", content: String(userText || "").slice(0, 1200) },
  ];

  // generate
  let resp;
  try {
    const model = await chooseModel();
    resp = await client.responses.create({
      model,
      input,
      max_output_tokens: 250, // a bit longer; “smarter” feels
      temperature: 0.9,       // extra playful/creative
      top_p: 0.95,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("429") || /quota|rate/i.test(msg)) {
      console.warn("[AI] Rate/Quota hit; quiet.");
      return null;
    }
    console.error("[AI] OpenAI error:", msg);
    return null;
  }

  let out = (resp?.output_text || "").trim();
  if (!out) return null;

  // tools dispatcher (rare; only if model asked)
  if (out.startsWith("TOOL:")){
    if (out.startsWith("TOOL:time_now")) out = await callTool("time_now");
    else if (out.startsWith("TOOL:flip")) out = await callTool("flip");
    else if (out.startsWith("TOOL:math:")) out = await callTool("math",{expr: out.split("TOOL:math:")[1]?.trim()});
  }

  // finalize guards (no language disclaimer!)
  out = limitEmoji(out);
  out = softToxicityGuard(out);
  out = pg13Guard(out);
  out = out.slice(0, 800);

  // save brief memory summary
  const newSummary = rollSummary(mem.summary, userText, out);
  saveMem(psid, { summary: newSummary });

  // if we just learned a name, sprinkle it (softly) sometimes
  if (name && !/(\bname\b|amar\s+(nam|naam|name)|my name is)/i.test(userText)) {
    // 40% chance to use the name naturally (not on every turn)
    if (Math.random() < 0.4 && !out.toLowerCase().includes(name.toLowerCase())) {
      out = out.replace(/\.$/, "") + `, ${name}!`;
    }
  }

  return out;
}
