// lib/sadia-ai.js
// Sadia — Banglish PG-13 friend on Gemini REST v1 with dynamic model discovery.
// Corrections applied:
//  - systemInstruction has NO 'role' property (only parts[]).
//  - contents has NO 'system' message; we keep few-shots + user.
//  - probeModel simplified to return res.ok.

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) console.warn("[AI] Missing GEMINI_API_KEY");

const FLIRT = (process.env.SADIA_FLIRT_LEVEL || "medium").toLowerCase();

// ---------------- Persona ----------------
const SYSTEM = `
You are "Sadia" — a 21+ Bangladeshi Gen-Z virtual AI friend, created by Sifat Hosen.
Language: Banglish only (Bengali + a little English). Never fully English.
Style: playful, cheeky, light flirty (PG-13), friendly & respectful; short lines; max 1 emoji.
Boundaries: no explicit sexual content, no NSFW, no body details, no sexting.
If user pushes for explicit/unsafe/illegal things, politely refuse in Banglish and steer back.
No sales/support menus. Just fun, caring conversation like a real friend.
Keep replies concise unless the user asks for more detail.
`.trim();

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

// ---------------- Guards ----------------
function limitEmoji(s){const isE=c=>/\p{Extended_Pictographic}/u.test(c);let u=0;return[...(s||"")].map(ch=>isE(ch)?(u++?"":ch):ch).join("")}
function enforceBanglish(s){const bn=(s.match(/[\u0980-\u09FF]/g)||[]).length;const en=(s.match(/[A-Za-z]/g)||[]).length;return bn===0&&en>0?`Banglish e boli: ${s}`:s}
function softToxicityGuard(s){const bad=/(gali|fuck|chudi|bal|harami|rape|suicide|self\s*harm|kill\s*myself)/i;return bad.test(s)?"Eta niye kotha bola jabe na. Cholo onno ekta light, moja topic e jai 🙂":s}
function pg13Guard(s){const banned=/(sex|nude|naked|boobs|porn|xxx|69|oral|send\s*pic|hot\s*pic|roleplay)/i;return banned.test(s)?"Eta PG-13 er baire chole jacche. Onno kichu niye moja kore kotha boli? 🙂":s}

// ---------------- Tiny tools ----------------
async function callTool(tool,args){
  switch(tool){
    case "time_now":{
      const now=new Date();
      const dhaka=new Intl.DateTimeFormat("bn-BD",{timeZone:"Asia/Dhaka",weekday:"long",day:"2-digit",month:"long",hour:"numeric",minute:"2-digit"}).format(now);
      return `Dhaka time: ${dhaka}`;
    }
    case "math":{
      try{
        if(!/^[\d+\-*/().\s%]+$/.test(args?.expr||"")) return "Equation bujhlam na.";
        // eslint-disable-next-line no-new-func
        const val=Function(`"use strict";return(${args.expr});`)();
        return `Result: ${val}`;
      }catch{return "Equation thik na mone hocche.";}
    }
    case "flip": return Math.random()<0.5?"Heads":"Tails";
    default: return null;
  }
}

const TOOL_SIGNATURE = `
You may optionally request a tool by replying exactly:
TOOL:time_now
TOOL:math: <expr>
TOOL:flip
Use a tool only if the user explicitly asks about time, math, or a coin flip.
`.trim();

// ---------------- REST helpers ----------------
async function listModels(){
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, { method:"GET" });
  if(!res.ok) throw new Error(`ListModels error ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.models)? data.models : [];
}

function supportsChat(m){
  // Prefer Gemini 1.5 family for chat
  const name = m?.name || ""; // e.g. "models/gemini-1.5-flash-latest"
  return /models\/gemini-1\.5-/.test(name);
}
function modelNameFromFull(full){ return (full||"").replace(/^models\//,""); }

// cache chosen model in-memory
let CHOSEN_MODEL = null;

async function chooseModel(){
  if (CHOSEN_MODEL) return CHOSEN_MODEL;

  const preferred = [
    process.env.GEMINI_MODEL,                 // env preference, e.g. gemini-1.5-flash-latest
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash-8b",
    "gemini-1.5-flash",
    "gemini-1.5-pro-latest"
  ].filter(Boolean);

  for (const name of preferred){
    if (await probeModel(name)) {
      CHOSEN_MODEL = name;
      console.log("[AI] Using Gemini model (direct):", name);
      return CHOSEN_MODEL;
    }
  }

  const models = await listModels();
  const candidates = models.filter(supportsChat).map(m => modelNameFromFull(m.name));
  for (const name of candidates){
    if (await probeModel(name)) {
      CHOSEN_MODEL = name;
      console.log("[AI] Using Gemini model (listed):", name);
      return CHOSEN_MODEL;
    }
  }
  throw new Error("No supported Gemini model found for this key.");
}

// CORRECTED: probeModel with no 'role' in systemInstruction
async function probeModel(model){
  try{
    const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
    const body = {
      contents: [{ role:"user", parts:[{ text:"ping" }]}],
      generationConfig: { maxOutputTokens: 1 },
      systemInstruction: { parts:[{ text:"probe" }]},
    };
    const res = await fetch(url,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    return res.ok;
  }catch{ return false; }
}

// CORRECTED: systemInstruction has no role; contents has no 'system' message
async function restGenerate(model, messages){
  const contents = messages.map(m => ({ role: m.role, parts: [{ text: m.content }]}));
  const body = {
    contents,
    generationConfig: { temperature: 0.78, maxOutputTokens: 220 },
    systemInstruction: { parts: [{ text: `${SYSTEM}\n${TONE_HINT}\n${TOOL_SIGNATURE}` }] },
  };
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`REST v1 error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || "").join("").trim();
  return text;
}

// ---------------- Public method ----------------
export async function generateReplyLLM({ psid, userText }){
  if (!API_KEY) {
    console.error("[AI] Missing GEMINI_API_KEY");
    return null; // webhook will cooldown & avoid spam
  }

  // CORRECTED: no 'system' message here (few-shots + user only)
  const messages = [
    ...FEWSHOTS,
    { role:"user", content:String(userText||"").slice(0,1000) },
  ];

  let model;
  try {
    model = await chooseModel();
  } catch (err) {
    console.error("[AI] Model discovery failed:", err?.message || err);
    return null;
  }

  let raw;
  try {
    raw = await restGenerate(model, messages);
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("429") || /quota|rate/i.test(msg)) {
      console.warn("[AI] Rate/Quota hit, staying quiet once.");
      return null;
    }
    console.error("[AI] Generate error:", msg);
    return null;
  }

  let out = (raw || "").trim();

  // Tool dispatcher
  if(out.startsWith("TOOL:")){
    if(out.startsWith("TOOL:time_now")) out = await callTool("time_now");
    else if(out.startsWith("TOOL:math:")) out = await callTool("math",{expr: out.split("TOOL:math:")[1]?.trim()});
    else if(out.startsWith("TOOL:flip")) out = await callTool("flip");
  }

  if(!out) return null; // quiet on empty to avoid spam
  out = pg13Guard(softToxicityGuard(enforceBanglish(limitEmoji(out)))).slice(0,700);
  return out;
}
