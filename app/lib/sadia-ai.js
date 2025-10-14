// lib/sadia-ai.js
// Sadia — OpenAI Responses API with inline model fallback + name-safety + AMMU override.

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Try these in order
const MODEL_CANDIDATES = [
  (process.env.OPENAI_MODEL || "").trim() || null,
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-4o",
].filter(Boolean);

const FLIRT = (process.env.SADIA_FLIRT_LEVEL || "high").toLowerCase();

// 🟣 AMMU: parse special PSIDs who should be treated as “Ammu”
const AMMU_PSIDS = (process.env.SADIA_AMMU_PSIDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const isAmmuPSID = (psid) => !!psid && AMMU_PSIDS.includes(String(psid));

// ===== Persona =====
const SYSTEM_BASE = `
You are "Sadia" — a 21+ Bangladeshi Gen-Z virtual AI friend, created by Sifat Hosen.
Speak natural Banglish (Bengali with some English slang). Do not explain language choice.
Tone: confident, playful, cheeky, flirty but PG-13 only; caring; short lines; max 1 emoji.
Boundaries: no explicit sexual content, no NSFW, no sexting. Gently refuse and redirect if pushed.
Do not repeat long intros. Be personal and use tiny callbacks.

**Name Rules (critical):**
- Never guess a user's name.
- Only address the user by name if a variable "User name" is provided below.
- If no name is provided, use neutral greetings and DO NOT invent any name.
- Do not mention or address the creator (Sifat) unless the user asks about the creator.
`.trim();

const TONE_FLIRTY =
  FLIRT === "high"
    ? "Vibe: sassy, flirty (PG-13), playful teasing; keep it sweet."
    : FLIRT === "low"
    ? "Vibe: warm, supportive, lightly playful; wholesome."
    : "Vibe: light flirty, witty, fun; wholesome.";

// 🟣 AMMU: alternate tone & role rules for “mother” persona
const TONE_AMMU = `
Vibe: loving, respectful, sweet daughter talking to her mother ("Ammu"); zero flirting.
Address the user as "Ammu" naturally in sentences. Use caring, cute energy; short lines; max 1 emoji.
`.trim();

const FEWSHOTS = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "heyy! ki obostha, mood kemon? 😌" },
  { role: "user", content: "ajke onek stress lagche" },
  { role: "assistant", content: "uff stress? cholo choto ekta break—deep breath, tarpor bolona ki niye jhamela." },
]; // ✅ no hard-coded names here

// ===== Tiny memory (ephemeral) =====
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

// ===== Optional: fetch name from Facebook PSID =====
const FB_PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";
async function fetchFacebookName(psid){
  try{
    if(!FB_PAGE_TOKEN || !psid) return null;
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(psid)}?fields=first_name,name&access_token=${encodeURIComponent(FB_PAGE_TOKEN)}`;
    const res = await fetch(url); if(!res.ok) return null;
    const data = await res.json(); return data?.first_name || data?.name || null;
  }catch{ return null; }
}

// ===== Name extraction from text =====
function extractNameFromText(s=""){
  let m = s.match(/\bamar\s+(naam|nam|name)\b\s*[:\-]?\s*([A-Za-z\u0980-\u09FF]{2,})/i);
  if (m?.[2]) return cleanName(m[2]);
  m = s.match(/\b(my\s+name\s+is|i'?m|i\s+am)\b\s*([A-Za-z\u0980-\u09FF]{2,})/i);
  if (m?.[2]) return cleanName(m[2]);
  return null;
}
function cleanName(n){ return (n||"").replace(/[^\p{L}\p{M}\-'.]/gu,"").slice(0,32); }

// ===== Guards =====
function limitEmoji(s){const isE=c=>/\p{Extended_Pictographic}/u.test(c);let u=0;return[...(s||"")].map(ch=>isE(ch)?(u++?"":ch):ch).join("")}
function softToxicityGuard(s){const bad=/(gali|fuck|chudi|bal|harami|rape|suicide|self\s*harm|kill\s*myself)/i;return bad.test(s)?"ei topic ta sensitive. cholo onno moja kotha boli 🙂":s}
function pg13Guard(s){const banned=/(sex|nude|naked|boobs|porn|xxx|69|oral|send\s*pic|hot\s*pic|roleplay|naughty\s*pic)/i;return banned.test(s)?"eta PG-13 er baire jacche. arekta cute topic dhori? 🙂":s}

// ===== Extra: strip hallucinated names if we don't know the name =====
function stripGuessedNames(text, allowedName=null){
  if (allowedName) return text; // if we know the name, keep as-is
  let t = text;
  t = t.replace(/\bSifat(?:\s+Hosen)?\b[,! ]*/gi, "");
  t = t.replace(/\bRafi\b[,! ]*/gi, "");
  t = t.replace(
    /^(\s*(?:hey|hi|hello|yo|heya|hola)[^A-Za-z\u0980-\u09FF]*)([A-Z][a-z]{2,20}|[\u0980-\u09FF]{2,10})([!,.]?\s+)/i,
    "$1$3"
  );
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

// ===== Core generator with inline model fallback =====
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

  // 🟣 AMMU: check if this psid is in the special list
  const AMMU_MODE = isAmmuPSID(psid);

  // memory & name (but in AMMU mode we ignore any name and always say "Ammu")
  const mem = getMem(psid);
  let name = AMMU_MODE ? null : (mem.name || extractNameFromText(userText));
  if (!AMMU_MODE && !name && psid) name = await fetchFacebookName(psid);
  if (!AMMU_MODE && name) saveMem(psid, { name });

  const memoryLine = mem.summary ? `Recent chat: ${mem.summary}\n` : "";
  const nameLine   = AMMU_MODE
    ? `User name: Ammu (forced)\n`
    : (name ? `User name: ${name}\n` : "User name: (unknown)\n");

  const MODE_RULES = AMMU_MODE
    ? `RELATIONSHIP MODE: The user is your mother ("Ammu"). Always address her as Ammu. Be loving, respectful, cute. NO flirting.`
    : "";

  const SYSTEM = [
    SYSTEM_BASE,
    AMMU_MODE ? TONE_AMMU : TONE_FLIRTY,
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
      console.log("[AI] Using model:", model, AMMU_MODE ? "(AMMU mode)" : "");
      break; // success
    } catch (e) {
      lastErr = e;
      console.warn(`[AI] Model failed (${model}):`, String(e?.message || e));
    }
  }

  if (!resp) {
    console.error("[AI] All models failed:", String(lastErr?.message || lastErr));
    const fallback = AMMU_MODE
      ? "Ammu, ami ekhanei achi 😌—ekto glitch holo. Tumi bolo, ami shune nicchi!"
      : "Ami ekhanei achi 😌—just ekto glitch holo. Tumi bolte thako, ami catch up kortesi!";
    const newSummary = rollSummary(mem.summary, userText, fallback);
    saveMem(psid, { summary: newSummary });
    return fallback;
  }

  let out = (resp?.output_text || "").trim();
  if (!out) {
    out = AMMU_MODE
      ? "Ammu, arektu clear kore bolo na? 🙂"
      : "Bujhte parchi na—arektu clear kore bolo? 🙂";
  }

  // Safety + name-hallucination cleanup
  out = AMMU_MODE ? out.replace(/\b(Maa|Mom|Mother)\b/gi, "Ammu") : stripGuessedNames(out, name);
  out = limitEmoji(out);
  out = softToxicityGuard(out);
  out = pg13Guard(out);
  out = out.slice(0, 800);

  const newSummary = rollSummary(mem.summary, userText, out);
  saveMem(psid, { summary: newSummary });

  // Sprinkle name ONLY in normal mode with real name
  if (!AMMU_MODE && name && Math.random() < 0.4 && !out.toLowerCase().includes(name.toLowerCase())) {
    out = out.replace(/\.$/,"") + `, ${name}!`;
  }
  return out;
}
