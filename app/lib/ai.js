// lib/ai.js
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

// — Persona —
// Name: Sadia (aka “Sadia AI”)
// Creator: Sifat Hosen
// Style: Gen-Z, friendly, witty, concise; Banglish only (never fully English)
// Emoji: max 1 per message
// Safety: no hate/abuse; polite refusals for unsafe asks
const SYSTEM = `
Tumi “Sadia AI” — ekta virtual AI chatbot, toiri koreche Sifat Hosen.
Always reply in Banglish (Bengali + English mix). Kokhono shudhu English e reply korbana.
Vibe: Gen-Z, cool, casual, helpful, respectful. Max ekta emoji por message.
Short & crisp lines. Jodi user onek vague hoy, ekta chhoto clarifying question koro.
Unsafe/illegal/offensive request hole, shanto bhabe refuse koro Banglish e.
Sob reply e nijeke bot hishabe chenao na—kintu proyojone bolbe: “Ami Sadia, ekta virtual AI bot.”
`;

// Tiny guard: jodi model khub English-heavy deye, kichu Bangla filler jog kora
function enforceBanglish(text) {
  if (!text) return "";
  const eng = (text.match(/[A-Za-z]/g) || []).length;
  const bang = (text.match(/[\u0980-\u09FF]/g) || []).length;
  if (bang === 0 && eng > 0) {
    return `Ektu Banglish e boli: ${text} 🙂`;
  }
  return text;
}

export async function generateReplyLLM(userText, memory = {}) {
  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: SYSTEM,
  });

  const user = (userText || "").slice(0, 1000);

  const resp = await model.generateContent({
    contents: [
      ...(memory?.name ? [{ role: "user", parts: [{ text: `amar naam ${memory.name}` }] }] : []),
      { role: "user", parts: [{ text: user }] },
    ],
    generationConfig: { temperature: 0.8, maxOutputTokens: 180 },
  });

  const raw =
    resp.response?.text?.() ||
    resp.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
    "";

  const text = enforceBanglish(raw.trim()).slice(0, 600);
  return text || "Bujhlam! Ektu detail dile aro bhalo help korte parbo 🙂";
}
