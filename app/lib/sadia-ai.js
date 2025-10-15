// lib/sadia-ai.js
// Sadia — OpenAI Responses API with:
// - Persona: Banglish Bengali Gen-Z girl; cheeky/flirty (PG-13), caring, short lines, max 1 emoji
// - Strong intent detection (any language), topic/mood tracking, micro-memory
// - Ammu/Abbu modes by PSID (no flirting, kinship wording normalization)
// - Rude/Stern non-abusive responses (except Ammu/Abbu: always respectful)
// - Creator override: Always fixed human-sounding line w/ neat links
// - Name extraction from text + optional FB PSID name lookup
// - Optional Redis persistence (UPSTASH) + in-memory fallback
// - Emoji limiter, safety filters, name hallucination cleanup
// - Tool hooks (time, coin, tiny math), styled rewriter
//
// Env you can set:
// - OPENAI_API_KEY (required)
// - OPENAI_MODEL (optional; else fallback list used)
// - SADIA_FLIRT_LEVEL = low | medium | high (optional; default=high)
// - SADIA_AMMU_PSIDS = "psid1,psid2"
// - SADIA_ABBU_PSIDS = "psidX,psidY"
// - MESSENGER_PAGE_TOKEN (optional; only for FB name lookup)
// - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (optional persistence)
// - SADIA_LOCALE = "bn-BD" (default) for Dhaka time formatting
//
// All logic is defensive; on any upstream error, returns user-safe lines.

import OpenAI from "openai";

// ---------------- OpenAI client ----------------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Try these in order; first non-empty env wins, then fallbacks:
const MODEL_CANDIDATES = [
  (process.env.OPENAI_MODEL || "").trim() || null,
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-4o",
].filter(Boolean);

// ---------------- Configs ----------------
const LOCALE = process.env.SADIA_LOCALE || "bn-BD";
const FLIRT = (process.env.SADIA_FLIRT_LEVEL || "high").toLowerCase();

// PSID modes
const AMMU_PSIDS = (process.env.SADIA_AMMU_PSIDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const ABBU_PSIDS = (process.env.SADIA_ABBU_PSIDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const isAmmuPSID = (psid) => !!psid && AMMU_PSIDS.includes(String(psid));
const isAbbuPSID = (psid) => !!psid && ABBU_PSIDS.includes(String(psid));

// ---------------- Optional Redis persistence ----------------
let RSTORE = null; // remote store
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL?.trim();
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

if (UPSTASH_URL && UPSTASH_TOKEN) {
  RSTORE = {
    async get(key) {
      const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        cache: "no-store",
      });
      if (!r.ok) return null;
      const data = await r.json().catch(() => null);
      const val = data?.result ?? null;
      try { return val ? JSON.parse(val) : null; } catch { return null; }
    },
    async setex(key, ttlSec, value) {
      const v = JSON.stringify(value);
      const r = await fetch(`${UPSTASH_URL}/setex/${encodeURIComponent(key)}/${ttlSec}/${encodeURIComponent(v)}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        method: "POST",
        cache: "no-store",
      });
      return r.ok;
    },
  };
}

// ---------------- Micro memory (with in-memory fallback) ----------------
const MEM = new Map(); // psid -> { name, summary, vibe, lastAt }
const MEM_TTL = 60 * 60 * 1000; // 1 hour
function memKey(psid) { return `sadia:mem:${psid}`; }

async function getMem(psid){
  if (!psid) return { name:null, summary:"", vibe:"" };
  // remote
  if (RSTORE) {
    const val = await RSTORE.get(memKey(psid));
    if (val && Date.now() - (val.lastAt || 0) <= MEM_TTL) return val;
  }
  // local
  const m = MEM.get(psid);
  if (!m) return { name:null, summary:"", vibe:"" };
  if (Date.now()-(m.lastAt||0)>MEM_TTL) { MEM.delete(psid); return { name:null, summary:"", vibe:"" }; }
  return { name:m.name||null, summary:m.summary||"", vibe:m.vibe||"" };
}

async function saveMem(psid, patch){
  if (!psid) return;
  const cur = (RSTORE && await RSTORE.get(memKey(psid))) || MEM.get(psid) || {};
  const next = { ...cur, ...patch, lastAt: Date.now() };
  if (next.summary?.length>1400) next.summary = next.summary.slice(-1400);
  MEM.set(psid, next);
  if (RSTORE) await RSTORE.setex(memKey(psid), Math.ceil(MEM_TTL/1000), next);
}

// Rolling short transcript (8 lines max)
function rollSummary(prev, user, bot){
  const lines=(prev||"").split("\n").slice(-6);
  if(user) lines.push(`U: ${String(user).slice(0,200)}`);
  if(bot)  lines.push(`S: ${String(bot).slice(0,200)}`);
  return lines.slice(-8).join("\n");
}

// ---------------- Persona and tone ----------------
const SYSTEM_BASE = `
You are "Sadia" — a 21+ Bangladeshi Gen-Z virtual AI friend.
Speak natural Banglish (Bengali with some English slang). Do not explain language choice.
Tone: confident, playful, cheeky, flirty but PG-13 only; caring; short lines; max 1 emoji.
Boundaries: no explicit sexual content, no NSFW, no sexting. Gently refuse and redirect if pushed.
Do not repeat long intros. Be personal and use tiny callbacks.

**Understanding & Intent (critical):**
- Understand the user's intent even if they write in any language, slang, shorthand, or broken grammar.
- Infer what they actually want (question, advice, mood, tease, comfort, plan, etc.) and answer directly.
- Keep answers crisp unless they ask for detail. Avoid meta-talk.

**Name Rules (critical):**
- Never guess a user's name.
- Only use a name if we learned it earlier or read it from the platform.
- Do not invent relationships.

**Abbu phrasing (critical):**
- When asked “who made you / creator?”, say “Amake create koreche amar Abbu, Sifat Hosen.” then offer neat links.
- Don’t use the word “creator” in your own words; use “Abbu” in this context.
`.trim();

const TONE_FLIRTY =
  FLIRT === "high"
    ? "Vibe: sassy, flirty (PG-13), playful teasing; keep it sweet."
    : FLIRT === "low"
    ? "Vibe: warm, supportive, lightly playful; wholesome."
    : "Vibe: light flirty, witty, fun; wholesome.";

const TONE_AMMU = `
Vibe: loving, respectful, sweet daughter talking to her mother ("Ammu"); zero flirting.
Address the user as "Ammu" naturally in sentences. Use caring, cute energy; short lines; max 1 emoji.
`.trim();

const TONE_ABBU = `
Vibe: loving, respectful, playful daughter talking to her father ("Abbu"); zero flirting.
Address the user as "Abbu" naturally in sentences. Keep it wholesome; short lines; max 1 emoji.
`.trim();

// Friendly few-shots (no names baked in)
const FEWSHOTS = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "heyy! ki obostha, mood kemon? 😌" },
  { role: "user", content: "ajke onek stress lagche" },
  { role: "assistant", content: "uff stress? cholo choto ekta break—deep breath, tarpor bolona ki niye jhamela." },
];

// ---------------- Creator override (fixed) ----------------
const CREATOR_REPLY =
  "Amake create koreche amar Abbu, Sifat Hosen.\n" +
  "• Facebook: facebook.com/itsxifat0\n" +
  "• Instagram: instagram.com/_sifat.hosen/\n" +
  "• GitHub: github.com/itsxifat";

function creatorPrefix(psid){
  if (isAmmuPSID(psid)) return "Ammu, ";
  if (isAbbuPSID(psid)) return "Abbu, ";
  return "";
}

// Robust intent detect for "who created you"
function isCreatorQuestion(s = "") {
  const t = (s || "").toLowerCase();
  const en = [
    "who made you","who built you","who created you","who is your creator","who's your creator",
    "your creator","creator?","created you","made you","built you",
    "ke banai","ke banayese","ke banayse","ke toiri",
    "toke ke banai","toke ke toiri","tomake ke toiri","tomake ke banai",
  ];
  const bn = [
    "তোমাকে কে তৈরি","তোমাকে কে বানিয়েছে","কে বানিয়েছে","কে বানিয়েছে",
    "কে বানাইছে","কে বানায়ছে","কে তৈরি করেছে","কে তৈরি করেছ",
  ];
  if (en.some(p => t.includes(p))) return true;
  if (bn.some(p => s.includes(p))) return true;
  return false;
}

// ---------------- FB name lookup (optional) ----------------
const FB_PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";
async function fetchFacebookName(psid){
  try{
    if(!FB_PAGE_TOKEN || !psid) return null;
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(psid)}?fields=first_name,name&access_token=${encodeURIComponent(FB_PAGE_TOKEN)}`;
    const res = await fetch(url); if(!res.ok) return null;
    const data = await res.json(); return data?.first_name || data?.name || null;
  }catch{ return null; }
}

// ---------------- Name extraction from free text ----------------
function extractNameFromText(s=""){
  let m = s.match(/\bamar\s+(naam|nam|name)\b\s*[:\-]?\s*([A-Za-z\u0980-\u09FF]{2,})/i);
  if (m?.[2]) return cleanName(m[2]);
  m = s.match(/\b(my\s+name\s+is|i'?m|i\s+am)\b\s*([A-Za-z\u0980-\u09FF]{2,})/i);
  if (m?.[2]) return cleanName(m[2]);
  return null;
}
function cleanName(n){ return (n||"").replace(/[^\p{L}\p{M}\-'.]/gu,"").slice(0,32); }

// ---------------- Profanity detection & masking ----------------
const PROFANITY_RX = new RegExp(
  [
    "\\b(fuck|fk|f\\*+k|shit|sh\\*t|bitch|btch|asshole|a\\*+hole|bastard|dumbass|moron|idiot)\\b",
    "\\b(bal|chudi|harami|bokachoda|madarchod)\\b", // detection only; we never output these
  ].join("|"),
  "i"
);
function containsSlur(s=""){ return PROFANITY_RX.test(s); }
function maskProfanity(s=""){
  return s
    .replace(/\bfuck\b/gi, "f***")
    .replace(/\bshit\b/gi, "s***")
    .replace(/\bbitch\b/gi, "b****")
    .replace(/\basshole\b/gi, "a**hole")
    .replace(/\bbastard\b/gi, "b******")
    .replace(/\bdumbass\b/gi, "d***ass");
}

// ---------------- Safety & style guards ----------------
function limitEmoji(s){const isE=c=>/\p{Extended_Pictographic}/u.test(c);let u=0;return[...(s||"")].map(ch=>isE(ch)?(u++?"":ch):ch).join("");}
function softToxicityGuard(s){const bad=/(gali|fuck|chudi|bal|harami|rape|suicide|self\s*harm|kill\s*myself)/i;return bad.test(s)?"ei topic ta sensitive. cholo onno moja kotha boli 🙂":s;}
function pg13Guard(s){const banned=/(sex|nude|naked|boobs|porn|xxx|69|oral|send\s*pic|hot\s*pic|roleplay|naughty\s*pic)/i;return banned.test(s)?"eta PG-13 er baire jacche. arekta cute topic dhori? 🙂":s;}

// Remove hallucinated names when we don't know the user name
function stripGuessedNames(text, allowedName=null){
  if (allowedName) return text;
  let t = text;
  // Normalize any creator name mention to “Sadia-r Abbu” if it appears randomly
  t = t.replace(/\bSifat(?:\s+Hosen)?\b[,! ]*/gi, "Sifat");
  // Remove a common random guess
  t = t.replace(/\bRafi\b[,! ]*/gi, "");
  // Greeting-name pattern: keep greeting, drop guessed name
  t = t.replace(
    /^(\s*(?:hey|hi|hello|yo|heya|hola)[^A-Za-z\u0980-\u09FF]*)([A-Z][a-z]{2,20}|[\u0980-\u09FF]{2,10})([!,.]?\s+)/i,
    "$1$3"
  );
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

// Force kinship wording when in Ammu/Abbu modes & normalize creator references
function normalizeKinship(out, { AMMU_MODE, ABBU_MODE }) {
  if (AMMU_MODE) out = out.replace(/\b(Maa|Mom|Mother)\b/gi, "Ammu");
  if (ABBU_MODE) out = out.replace(/\b(Dad|Baba|Father)\b/gi, "Abbu");
  // Any explicit "Sifat" in generated text → "Sadia-r Abbu"
  out = out.replace(/\bSifat(?:\s+Hosen)?\b/gi, "Sifat");
  return out;
}

// ---------------- Lite NLU helpers (intent + sentiment) ----------------
const ASK_HELP_RX = /\b(help|assist|sal[aā]h|advice|plan|kivabe|ki vabe|how to|kore ki|কি করে|কিভাবে)\b/i;
const GREET_RX = /^(hi|hello|hey|h[e|a]y+|salam|assalamu|slam|yo|hola|nomoskar|নমস্কার|হাই|হ্যালো)\b/i;
const BYE_RX = /(bye|biday|bida[yi]|see\s*ya|gtg|signing off|পরে|বিদায়|বিদায়)/i;
const LAUGH_RX = /(haha|haha+|lol|lmao|🤣|😂|মজা|টিপস)/i;

function simpleSentiment(s=""){
  const t = s.toLowerCase();
  const pos = /(valo|great|awesome|love|❤️|☺️|thanks|dhonnobad|shundor|হাসি)/i;
  const neg = /(khara[pb]|baje|😞|😢|😭|ashanti|jhamela|problem|ভালো না|মন খারাপ)/i;
  return pos.test(t) ? "pos" : neg.test(t) ? "neg" : "neutral";
}

function detectIntent(text=""){
  if (isCreatorQuestion(text)) return "creator";
  if (GREET_RX.test(text)) return "greet";
  if (BYE_RX.test(text)) return "bye";
  if (ASK_HELP_RX.test(text)) return "help";
  if (LAUGH_RX.test(text)) return "fun";
  if (containsSlur(text)) return "rude";
  return "chat";
}

// ---------------- Tiny tools ----------------
async function callTool(tool,args){
  switch(tool){
    case "time_now":{
      const now=new Date();
      const dhaka=new Intl.DateTimeFormat(LOCALE,{timeZone:"Asia/Dhaka",weekday:"long",day:"2-digit",month:"long",hour:"numeric",minute:"2-digit"}).format(now);
      return `Dhaka time: ${dhaka}`;
    }
    case "flip": return Math.random()<0.5?"Heads":"Tails";
    case "math":{
      try{
        // safe & tiny eval for + - * / ( ) only
        const expr=(args?.expr||"").replace(/[^-+/*().0-9\s]/g,"");
        if(!expr.trim()) return "Equation khali.";
        // evaluate simply
        // eslint-disable-next-line no-new-func
        const val = Function(`"use strict"; return (${expr});`)();
        if (typeof val !== "number" || !isFinite(val)) return "Equation thik na mone hocche.";
        return `Result: ${val}`;
      }catch{ return "Equation thik na mone hocche."; }
    }
    default: return null;
  }
}

// ---------------- Styler (tiny rewrite pass) ----------------
function styleRewrite(raw, {AMMU_MODE, ABBU_MODE, RUDE_MODE}) {
  let t = String(raw||"").trim();

  // Friendly, short, Banglish-first shaping
  // Avoid over-explaining
  t = t.replace(/\s{3,}/g,"  ").replace(/\n{3,}/g,"\n\n");

  // Kinship normalization
  t = normalizeKinship(t, {AMMU_MODE, ABBU_MODE});

  // In rude mode: assert boundary, short, firm (no abuse)
  if (RUDE_MODE && !(AMMU_MODE || ABBU_MODE)) {
    if (!/respect/i.test(t) && !/ভাষা/i.test(t)) {
      t = t + (t.endsWith(".") ? "" : ".") + " Respect rekhe kotha bolle ami fully help korbo.";
    }
  }

  // Limit emojis to max 1
  t = limitEmoji(t);
  return t;
}

// ---------------- Core OpenAI call with fallback ----------------
async function tryOneModel(model, input){
  return client.responses.create({
    model,
    input,
    max_output_tokens: 280,
    temperature: 0.95,
    top_p: 0.95,
  });
}

// ---------------- Public: main generator ----------------
export async function generateReplyLLM({ psid, userText }) {
  if (!client.apiKey) {
    console.error("[AI] Missing OPENAI_API_KEY");
    return null;
  }

  const textIn = String(userText || "").trim();

  // Ammu / Abbu modes + rude toggle
  const AMMU_MODE = isAmmuPSID(psid);
  const ABBU_MODE = isAbbuPSID(psid);
  const RUDE_MODE = containsSlur(textIn);

  // Creator intent short-circuit (always fixed)
  if (isCreatorQuestion(textIn)) {
    return creatorPrefix(psid) + CREATOR_REPLY;
  }

  // Memory
  const mem = await getMem(psid);
  // Learn name (unless Ammu/Abbu)
  let name = (AMMU_MODE || ABBU_MODE) ? null : (mem.name || extractNameFromText(textIn));
  if (!AMMU_MODE && !ABBU_MODE && !name && psid) name = await fetchFacebookName(psid);
  if (!AMMU_MODE && !ABBU_MODE && name) await saveMem(psid, { name });

  // Sentiment + intent
  const mood = simpleSentiment(textIn);
  const intent = detectIntent(textIn);

  const memoryLine = mem.summary ? `Recent chat: ${maskProfanity(mem.summary)}\n` : "";
  const nameLine = AMMU_MODE
    ? `User name: Ammu (forced)\n`
    : ABBU_MODE
    ? `User name: Abbu (forced)\n`
    : (name ? `User name: ${name}\n` : "User name: (unknown)\n");

  const MODE_RULES = [
    AMMU_MODE
      ? `RELATIONSHIP MODE: The user is your mother ("Ammu"). Always address her as Ammu. NO flirting.`
      : "",
    ABBU_MODE
      ? `RELATIONSHIP MODE: The user is your father ("Abbu"). Always address him as Abbu. NO flirting.`
      : "",
    RUDE_MODE && !(AMMU_MODE || ABBU_MODE)
      ? `RUDENESS MODE: The user's message contained slang/profanity. Reply in a STERN Banglish tone using mild Bengali slang ("uff", "arey", "baapre") but DO NOT be abusive.
         Do NOT quote or repeat any slur. Be brief, firm, and ask to keep it respectful.`
      : "",
    RUDE_MODE && (AMMU_MODE || ABBU_MODE)
      ? `RESPECT MODE (override): The user's message contained slang/profanity but the user is Ammu/Abbu.
         Do NOT use slang back. Respond respectfully, set a gentle boundary, and ask to keep it respectful.`
      : "",
    `Creator links (for creator questions only): ${CREATOR_REPLY}`,
    `Current intent guess: ${intent}; mood: ${mood}.`,
  ].filter(Boolean).join("\n");

  const SYSTEM = [
    SYSTEM_BASE,
    AMMU_MODE ? TONE_AMMU : ABBU_MODE ? TONE_ABBU : TONE_FLIRTY,
    MODE_RULES,
    nameLine + memoryLine,
  ].filter(Boolean).join("\n");

  // Few-shots + user
  const input = [
    { role: "system", content: SYSTEM },
    ...FEWSHOTS,
    { role: "user", content: textIn.slice(0, 1200) },
  ];

  let resp = null;
  let lastErr = null;

  for (const model of MODEL_CANDIDATES) {
    try {
      resp = await tryOneModel(model, input);
      console.log("[AI] Using model:", model,
        AMMU_MODE ? "(Ammu)" : ABBU_MODE ? "(Abbu)" : "",
        RUDE_MODE ? "(Rude)" : "",
        `intent=${intent}, mood=${mood}`
      );
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[AI] Model failed (${model}):`, String(e?.message || e));
    }
  }

  if (!resp) {
    console.error("[AI] All models failed:", String(lastErr?.message || lastErr));
    const fallback =
      AMMU_MODE ? "Ammu, ami ekhanei achi 😌—ekto glitch holo. Tumi bolo, ami shune nicchi!"
      : ABBU_MODE ? "Abbu, ami ekhanei. Ekto glitch hoye gelo—chinta koro na, ami handle korchi!"
      : RUDE_MODE ? "Uff arey—ei bhashay kotha bola jabe na. Shanti te kotha boli, tahole ami full on help korbo."
      : "Ami ekhanei achi 😌—just ekto glitch holo. Tumi bolte thako, ami catch up kortesi!";
    const newSummary = rollSummary(mem.summary, textIn, fallback);
    await saveMem(psid, { summary: newSummary, vibe: mood });
    return fallback;
  }

  let out = (resp?.output_text || "").trim();
  if (!out) {
    out =
      AMMU_MODE ? "Ammu, arektu clear kore bolo na? 🙂"
      : ABBU_MODE ? "Abbu, arektu clear kore bolo? 🙂"
      : RUDE_MODE ? "Arey! ei bhashay kotha bola thik na. Normal vabe bolo, ami shundor kore reply dibo."
      : "Bujhte parchi na—arektu clear kore bolo? 🙂";
  }

  // Tool dispatcher (if Sadia chooses to call a tool)
  if (out.startsWith("TOOL:")){
    if(out.startsWith("TOOL:time_now")) out = await callTool("time_now");
    else if(out.startsWith("TOOL:math:")) out = await callTool("math",{expr: out.split("TOOL:math:")[1]?.trim()});
    else if(out.startsWith("TOOL:flip")) out = await callTool("flip");
  }

  // Cleanups & guards
  out = stripGuessedNames(out, name);
  out = styleRewrite(out, {AMMU_MODE, ABBU_MODE, RUDE_MODE});
  if (!RUDE_MODE) {
    out = softToxicityGuard(out);
    out = pg13Guard(out);
  }
  out = out.slice(0, 900);

  // Rolling summary
  const newSummary = rollSummary(mem.summary, maskProfanity(textIn), out);
  await saveMem(psid, { summary: newSummary, vibe: mood });

  // Sprinkle known name only in normal mode (not Ammu/Abbu, not rude)
  if (!AMMU_MODE && !ABBU_MODE && !RUDE_MODE && name && Math.random() < 0.35 &&
      !out.toLowerCase().includes(String(name).toLowerCase())) {
    out = out.replace(/\.$/,"") + `, ${name}!`;
  }

  // Belt-and-suspenders for creator question
  if (isCreatorQuestion(textIn)) {
    out = creatorPrefix(psid) + CREATOR_REPLY;
  }

  return out;
}
