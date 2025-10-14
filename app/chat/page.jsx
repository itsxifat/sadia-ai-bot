"use client";
import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_CHAT_API_BASE?.trim() || "/api/chat";
const API_TOKEN = process.env.NEXT_PUBLIC_CHAT_API_TOKEN?.trim() || "";
const LS_KEY_PREFIX = "sadia:chat:"; // history per psid

// -- tiny helpers --
const uuid = () =>
  (crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`);

function getParamPSID() {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  return url.searchParams.get("psid");
}

function getOrCreatePSID() {
  const fromUrl = getParamPSID();
  if (fromUrl) return fromUrl;
  const existing = localStorage.getItem("sadia:psid");
  if (existing) return existing;
  const id = `web-${uuid()}`;
  localStorage.setItem("sadia:psid", id);
  return id;
}

export default function ChatPage() {
  const [psid, setPsid] = useState("");
  const [messages, setMessages] = useState([
    { role: "model", text: "Slam! Ami Sadia 😌—kotha bolo, ki khobor?" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const listRef = useRef(null);
  const inputRef = useRef(null);

  // resolve psid + load saved history
  useEffect(() => {
    const id = getOrCreatePSID();
    setPsid(id);
    const saved = localStorage.getItem(LS_KEY_PREFIX + id);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length) setMessages(parsed);
      } catch {}
    }
    // focus
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // persist history
  useEffect(() => {
    if (!psid) return;
    localStorage.setItem(LS_KEY_PREFIX + psid, JSON.stringify(messages));
  }, [messages, psid]);

  // auto-scroll
  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  const canSend = useMemo(
    () => !loading && input.trim().length > 0,
    [loading, input]
  );

  async function sendMessage(e) {
    e?.preventDefault?.();
    if (!canSend) return;
    setErr("");
    const text = input.trim();
    setInput("");

    // push user message
    setMessages((m) => [...m, { role: "user", text }]);
    setLoading(true);

    try {
      const res = await fetch(API_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(API_TOKEN ? { "x-api-token": API_TOKEN } : {}),
        },
        body: JSON.stringify({ userText: text, psid }),
      });

      const data = await res.json().catch(() => ({}));
      const reply =
        (typeof data?.reply === "string" && data.reply.trim()) ||
        (data?.error ? `Oops: ${data.error}` : "Bujhlam na—abar bolben? 🙂");

      setMessages((m) => [...m, { role: "model", text: reply }]);
    } catch (e) {
      setErr("Network error. Pore abar chesta korun 🙂");
      setMessages((m) => [
        ...m,
        { role: "model", text: "Net e jhamela hocche. Ektu pore try kori? 🙂" },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) sendMessage(e);
    }
  }

  function clearChat() {
    setMessages([{ role: "model", text: "Clear kore dilam! Nobo kore start kori 😌" }]);
    localStorage.removeItem(LS_KEY_PREFIX + psid);
  }

  function copyLast() {
    const last = [...messages].reverse().find((m) => m.role === "model")?.text;
    if (!last) return;
    navigator.clipboard?.writeText(last);
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <header style={styles.header}>
          <div style={styles.title}>Sadia 🫶</div>
          <div style={styles.subtitle}>
            Banglish Gen-Z chat {psid ? <span style={{ opacity: 0.6 }}>· {psid}</span> : null}
          </div>
          <div style={styles.actions}>
            <button onClick={copyLast} style={styles.secondaryBtn} title="Copy last reply">
              Copy
            </button>
            <button onClick={clearChat} style={styles.secondaryBtn} title="Clear chat">
              Clear
            </button>
          </div>
        </header>

        <div ref={listRef} style={styles.messages}>
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} text={m.text} />
          ))}
          {loading && <TypingBubble />}
        </div>

        {err ? <div style={styles.error}>{err}</div> : null}

        <form onSubmit={sendMessage} style={styles.inputRow}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type here... (Banglish e bolo) ✍️  (Shift+Enter = new line)"
            style={styles.input}
            disabled={loading}
            rows={1}
          />
          <button type="submit" style={styles.button} disabled={!canSend}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function Bubble({ role, text }) {
  const isUser = role === "user";
  return (
    <div
      style={{
        ...styles.bubble,
        alignSelf: isUser ? "flex-end" : "flex-start",
        background: isUser ? "#2563eb" : "#0f172a",
        color: "white",
        borderTopRightRadius: isUser ? 4 : 16,
        borderTopLeftRadius: isUser ? 16 : 4,
      }}
    >
      {text}
    </div>
  );
}

function TypingBubble() {
  return (
    <div style={{ ...styles.bubble, background: "#0f172a", color: "white", alignSelf: "flex-start" }}>
      <span style={styles.dot} />
      <span style={{ ...styles.dot, animationDelay: "0.15s" }} />
      <span style={{ ...styles.dot, animationDelay: "0.3s" }} />
      <style>{`
        @keyframes blink {
          0% { opacity: .2; }
          20% { opacity: 1; }
          100% { opacity: .2; }
        }
      `}</style>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100dvh",
    background: "linear-gradient(180deg,#0b1220,#0b1220 60%,#0e1628)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 720,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 16,
    backdropFilter: "blur(6px)",
    boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    padding: "16px 20px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  title: { fontSize: 18, fontWeight: 700, color: "white" },
  subtitle: { fontSize: 12, color: "#9da3ae", marginTop: 2, flex: 1 },
  actions: { display: "flex", gap: 8 },
  messages: {
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    height: "58dvh",
    overflowY: "auto",
  },
  bubble: {
    padding: "10px 12px",
    fontSize: 15,
    lineHeight: 1.5,
    borderRadius: 16,
    maxWidth: "85%",
    wordBreak: "break-word",
    boxShadow: "0 6px 16px rgba(0,0,0,0.25)",
  },
  dot: {
    display: "inline-block",
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "white",
    marginRight: 6,
    animation: "blink 1.4s infinite both",
  },
  inputRow: {
    display: "flex",
    gap: 8,
    padding: 12,
    borderTop: "1px solid rgba(255,255,255,0.08)",
  },
  input: {
    flex: 1,
    background: "#0b1220",
    color: "white",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 12,
    padding: "12px 14px",
    fontSize: 15,
    outline: "none",
    resize: "none",
  },
  button: {
    background: "#2563eb",
    color: "white",
    border: "none",
    borderRadius: 12,
    padding: "12px 16px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  error: {
    color: "#fda4af",
    fontSize: 12,
    padding: "4px 16px 0",
  },
};
