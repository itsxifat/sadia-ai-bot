// lib/sadia-ai.js
// Sadia (Gemini, free-tier). Uses SDK when possible; falls back to raw REST v1 if SDK is stuck on v1beta.

import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) console.warn("[AI] Missing GEMINI_API_KEY");

const FLIRT = (process.env.SADIA_FLIRT_LEVEL || "medium").toLowerCase();
const PREFERRED_MODELS = [
  process.env.GEMINI_MODEL,            // e.g., gemini-1.5-flash-latest
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-8b",
  "gemini-1.5-flash",
].filter(Boolean);

// ---------------- Persona (PG-13 Banglish friend) ----------------
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

// ----------------- Guards -----------------
function limitEmoji(s){const isE=c=>/\p{Extended_Pictographic}/u.test(c);let u=0;return[...(s||"")].map(ch=>isE(ch)?(u++?"":ch):ch).join("")}
function enforceBanglish(s){const bn=(s.match(/[\u0980-\u09FF]/g)||[]).length;const en=(s.match(/[A-Za-z]/g)||[]).length;return bn===0&&en>0?`Banglish e boli: ${s}`:s}
function softToxicityGuard(s){const bad=/(gali|fuck|chudi|bal|harami|rape|suicide|self\s*harm|kill\s*myself)/i;return bad.test(s)?"Eta niye kotha bola jabe na. Cholo onno ekta light, moja topic e jai 🙂":s}
function pg13Guard(s){const banned=/(sex|nude|naked|boobs|porn|xxx|69|oral|send\s*pic|hot\s*pic|roleplay)/i;return banned.test(s)?"Eta PG-13 er baire chole jacche. Onno kichu niye moja kore kotha boli? 🙂":s}

// ----------------- Tiny tools -----------------
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
`;

// ----------------- SDK path (preferred) -----------------
let sdkClient = null;
try {
  sdkClient = new GoogleGenerativeAI(API_KEY);
} catch { /* ignore; we'll use REST fallback */ }

async function trySdkOnce(modelName, messages){
  if(!sdkClient) throw new Error("SDK not available");
  const handle = sdkClient.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM + "\n" + TONE_HINT + "\n" + TOOL_SIGNATURE,
  });
  // probe (ensures model exists for your key/region)
  await handle.generateContent({
    contents: [{ role:"user", parts:[{ text:"ping" }]}],
    generationConfig: { maxOutputTokens: 1 },
  });
  const resp = await handle.generateContent({
    contents: messages.map(m=>({ role:m.role, parts:[{ text:m.content }]})),
    generationConfig: { temperature: 0.78, maxOutputTokens: 220 },
  });
  return resp.response?.text?.() || "";
}

// ----------------- REST v1 fallback (always works if key is valid) -----------------
async function restGenerate(modelName, messages){
  // messages -> contents
  const contents = messages.map(m => ({ role: m.role, parts: [{ text: m.content }]}));
  const body = {
    contents,
    generationConfig: { temperature: 0.78, maxOutputTokens: 220 },
    // systemInstruction for REST goes at top-level too
    systemInstruction: { role: "system", parts: [{ text: SYSTEM + "\n" + TONE_HINT + "\n" + TOOL_SIGNATURE }] },
  };
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  if(!res.ok){
    const txt = await res.text();
    throw new Error(`REST v1 error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  // extract text
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || "").join("").trim();
  return text;
}

// ----------------- Model chooser that tries SDK first, then REST -----------------
async function generateWithFallback(messages){
  let lastErr = null;
  for(const model of PREFERRED_MODELS){
    // 1) SDK path
    try {
      const out = await trySdkOnce(model, messages);
      console.log("[AI] Using SDK model:", model);
      return out;
    } catch (e) {
      lastErr = e;
      // If the SDK is stuck on v1beta in your build, it'll 404 here; we try REST next.
    }
    // 2) REST v1 path
    try {
      const out = await restGenerate(model, messages);
      console.log("[AI] Using REST v1 model:", model);
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("No Gemini model available for this key/region.");
}

// ----------------- Public API -----------------
export async function generateReplyLLM({ psid, userText }){
  // Stateless minimal context (works fine on free tier)
  const messages = [
    { role:"system", content:"Brief context: (stateless free-tier mode)" },
    ...FEWSHOTS,
    { role:"user", content:String(userText||"").slice(0,1000) },
  ];

  let raw;
  try {
    raw = await generateWithFallback(messages);
  } catch (err) {
    const msg = String(err?.message || "");
    if (msg.includes("429") || msg.toLowerCase().includes("rate")) {
      return "Free limit ta ektu cross hoye geche mone hocche. Ektu pore abar try kori? 🙂";
    }
    console.error("[AI] Gemini error:", msg);
    return "Ekto tech jhamela hocche. Ektu pore abar try kori? 🙂";
  }

  // Tool dispatcher
  let out = (raw || "").trim();
  if(out.startsWith("TOOL:")){
    if(out.startsWith("TOOL:time_now")) out = await callTool("time_now");
    else if(out.startsWith("TOOL:math:")) out = await callTool("math",{expr: out.split("TOOL:math:")[1]?.trim()});
    else if(out.startsWith("TOOL:flip")) out = await callTool("flip");
  }

  if(!out) out = "Bujhlam na—aro ektu clear kore bolben? 🙂";
  out = pg13Guard(softToxicityGuard(enforceBanglish(limitEmoji(out)))).slice(0,700);
  return out;
}
