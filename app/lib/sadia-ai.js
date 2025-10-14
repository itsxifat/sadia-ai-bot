// lib/sadia-ai.js
// Sadia — OpenAI Responses API with inline model fallback
// + Ammu/Abbu modes, intent override for "who created you", stern (non-abusive) rude mode
// + Name memory, FB name lookup, safety & style guards

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Try these in order; first non-empty env wins, then fallbacks:
const MODEL_CANDIDATES = [
  (process.env.OPENAI_MODEL || "").trim() || null,
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-4o",
].filter(Boolean);

const FLIRT = (process.env.SADIA_FLIRT_LEVEL || "high").toLowerCase();

// ── Special PSIDs (comma-separated in env) ─────────────────────────────────────
const AMMU_PSIDS = (process.env.SADIA_AMMU_PSIDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const ABBU_PSIDS = (process.env.SADIA_ABBU_PSIDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const isAmmuPSID = (psid) => !!psid && AMMU_PSIDS.includes(String(psid));
const isAbbuPSID = (psid) => !!psid && ABBU_PSIDS.includes(String(psid));

// ── Persona & style ───────────────────────────────────────────────────────────
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
- When asked “who made you / creator?”, say “Sifat holo Sadia-r Abbu” (not “creator”) and include the links provided by the system.
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

const FEWSHOTS = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "heyy! ki obostha, mood kemon? 😌" },
  { role: "user", content: "ajke onek stress lagche" },
  { role: "assistant", content: "uff stress? cholo choto ekta break—deep breath, tarpor bolona ki niye jhamela." },
]; // no hard-coded names

// ── “Creator” fixed reply (always this) ───────────────────────────────────────
const CREATOR_REPLY =
  "Sifat holo Sadia-r Abbu. Facebook: https://www.facebook.com/itsxifat0  Instagram: https://www.instagram.com/_sifat.hosen/  GitHub: https://www.github.com/itsxifat";

// Detect “who created you?” in many phrasings (no regex pitfalls)
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

// ── Ephemeral memory (serverless-friendly) ────────────────────────────────────
const MEM = new Map(); // psid -> { name, summary, lastAt }
const MEM_TTL = 60 * 60 * 1000;
function getMem(psid){ const m = psid && MEM.get(psid); if(!m) return { name:null, summary:"" };
  if(Date.now()-(m.lastAt||0)>MEM_TTL){ MEM.delete(psid); return { name:null, summary:"" }; }
  return { name:m.name||null, summary:m.summary||"" };
}
function saveMem(psid, patch){ if(!psid) return; const cur=MEM.get(psid)||{};
  const next={...cur,...patch,lastAt:Date.now()}; if(next.summary?.length>1000) next.summary=next.summary.slice(-1000); MEM.set(psid,next); }
function rollSummary(prev, user, bot){ const lines=(prev||"").split("\n").slice(-6);
  if(user) lines.push(`U: ${String(user).slice(0,180)}`); if(bot) lines.push(`S: ${String(bot).slice(0,180)}`);
  return lines.slice(-8).join("\n");
}

// ── Optional FB name lookup ───────────────────────────────────────────────────
const FB_PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";
async function fetchFacebookName(psid){
  try{
    if(!FB_PAGE_TOKEN || !psid) return null;
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(psid)}?fields=first_name,name&access_token=${encodeURIComponent(FB_PAGE_TOKEN)}`;
    const res = await fetch(url); if(!res.ok) return null;
    const data = await res.json(); return data?.first_name || data?.name || null;
  }catch{ return null; }
}

// ── Name extraction from raw text ─────────────────────────────────────────────
function extractNameFromText(s=""){
  let m = s.match(/\bamar\s+(naam|nam|name)\b\s*[:\-]?\s*([A-Za-z\u0980-\u09FF]{2,})/i);
  if (m?.[2]) return cleanName(m[2]);
  m = s.match(/\b(my\s+name\s+is|i'?m|i\s+am)\b\s*([A-Za-z\u0980-\u09FF]{2,})/i);
  if (m?.[2]) return cleanName(m[2]);
  return null;
}
function cleanName(n){ return (n||"").replace(/[^\p{L}\p{M}\-'.]/gu,"").slice(0,32); }

// ── Profanity detection (to switch to stern mode) & masking ───────────────────
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

// ── Guards / cleanups ────────────────────────────────────────────────────────
function limitEmoji(s){const isE=c=>/\p{Extended_Pictographic}/u.test(c);let u=0;return[...(s||"")].map(ch=>isE(ch)?(u++?"":ch):ch).join("")}
function softToxicityGuard(s){const bad=/(gali|fuck|chudi|bal|harami|rape|suicide|self\s*harm|kill\s*myself)/i;return bad.test(s)?"ei topic ta sensitive. cholo onno moja kotha boli 🙂":s}
function pg13Guard(s){const banned=/(sex|nude|naked|boobs|porn|xxx|69|oral|send\s*pic|hot\s*pic|roleplay|naughty\s*pic)/i;return banned.test(s)?"eta PG-13 er baire jacche. arekta cute topic dhori? 🙂":s}

// Remove hallucinated names when we don't know the user name
function stripGuessedNames(text, allowedName=null){
  if (allowedName) return text;
  let t = text;
  // Normalize any creator name mention to "Sadia-r Abbu"
  t = t.replace(/\bSifat(?:\s+Hosen)?\b[,! ]*/gi, "Sadia-r Abbu");
  // Remove common random guesses
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
  // Any explicit "Sifat" → "Sadia-r Abbu"
  out = out.replace(/\bSifat(?:\s+Hosen)?\b/gi, "Sadia-r Abbu");
  return out;
}

// ── Core OpenAI call with fallback ────────────────────────────────────────────
async function tryOneModel(model, input){
  return client.responses.create({
    model,
    input,
    max_output_tokens: 250,
    temperature: 0.9,
    top_p: 0.95,
  });
}

export async function generateReplyLLM({ psid, userText }) {
  if (!client.apiKey) {
    console.error("[AI] Missing OPENAI_API_KEY");
    return null;
  }

  const AMMU_MODE = isAmmuPSID(psid);
  const ABBU_MODE = isAbbuPSID(psid);
  const RUDE_MODE = containsSlur(userText || "");

  // ── “Who created you?” → always fixed line
  if (isCreatorQuestion(userText || "")) {
    if (AMMU_MODE) return `Ammu, ${CREATOR_REPLY}`;
    if (ABBU_MODE) return `Abbu, ${CREATOR_REPLY}`;
    return CREATOR_REPLY;
  }

  // Memory & name (Ammu/Abbu ignore name usage)
  const mem = getMem(psid);
  let name = (AMMU_MODE || ABBU_MODE) ? null : (mem.name || extractNameFromText(userText));
  if (!AMMU_MODE && !ABBU_MODE && !name && psid) name = await fetchFacebookName(psid);
  if (!AMMU_MODE && !ABBU_MODE && name) saveMem(psid, { name });

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
         Do NOT quote or repeat any slur. Be firm, set boundary, and ask to keep it respectful.`
      : "",
    RUDE_MODE && (AMMU_MODE || ABBU_MODE)
      ? `RESPECT MODE (override): The user's message contained slang/profanity but the user is Ammu/Abbu.
         Do NOT use slang back. Respond respectfully, set a gentle boundary, and ask to keep it respectful.`
      : "",
    `Creator links (for creator questions only): ${CREATOR_REPLY}`
  ].filter(Boolean).join("\n");

  const SYSTEM = [
    SYSTEM_BASE,
    AMMU_MODE ? TONE_AMMU : ABBU_MODE ? TONE_ABBU : TONE_FLIRTY,
    MODE_RULES,
    nameLine + memoryLine,
  ].filter(Boolean).join("\n");

  const input = [
    { role: "system", content: SYSTEM },
    ...FEWSHOTS,
    { role: "user", content: String(userText || "").slice(0, 1200) },
  ];

  let resp = null;
  let lastErr = null;

  for (const model of MODEL_CANDIDATES) {
    try {
      resp = await tryOneModel(model, input);
      console.log("[AI] Using model:", model,
        AMMU_MODE ? "(Ammu)" : ABBU_MODE ? "(Abbu)" : "",
        RUDE_MODE ? "(Rude)" : "");
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
    const newSummary = rollSummary(mem.summary, userText, fallback);
    saveMem(psid, { summary: newSummary });
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

  // Normalize kinship words & replace creator name with "Sadia-r Abbu"
  out = normalizeKinship(out, { AMMU_MODE, ABBU_MODE });

  // Safety: mask any profanity that slipped, limit emojis
  out = maskProfanity(out);
  out = limitEmoji(out);

  // For normal (non-rude) messages, keep PG-13 guard
  if (!RUDE_MODE) {
    out = softToxicityGuard(out);
    out = pg13Guard(out);
  }

  out = out.slice(0, 800);

  const newSummary = rollSummary(mem.summary, maskProfanity(userText || ""), out);
  saveMem(psid, { summary: newSummary });

  // Sprinkle known name only in normal mode (not Ammu/Abbu, not rude)
  if (!AMMU_MODE && !ABBU_MODE && !RUDE_MODE && name && Math.random() < 0.4 &&
      !out.toLowerCase().includes(name.toLowerCase())) {
    out = out.replace(/\.$/, "") + `, ${name}!`;
  }

  // Belt-and-suspenders: if this was a creator Q, enforce fixed line
  if (isCreatorQuestion(userText || "")) {
    out = (AMMU_MODE ? "Ammu, " : ABBU_MODE ? "Abbu, " : "") + CREATOR_REPLY;
  }

  return out;
}
