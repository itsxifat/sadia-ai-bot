// app/chat/page.jsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_CHAT_API_BASE?.trim() || "/api/chat";
const API_TOKEN = process.env.NEXT_PUBLIC_CHAT_API_TOKEN?.trim() || "";

export default function ChatPage() {
  const [messages, setMessages] = useState([
    { role: "model", text: " Ami Sadia 😌—bolo, ki khobor?" , t: Date.now() },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const listRef = useRef(null);
  const taRef = useRef(null);

  // auto-scroll
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // format time
  const fmt = (ms) =>
    new Intl.DateTimeFormat("bn-BD", { hour: "numeric", minute: "2-digit" }).format(new Date(ms));

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text, t: Date.now() }]);
    setLoading(true);

    try {
      const res = await fetch(API_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(API_TOKEN ? { "x-api-token": API_TOKEN } : {}),
        },
        body: JSON.stringify({ userText: text }),
      });
      const data = await res.json().catch(() => ({}));
      const reply =
        (typeof data?.reply === "string" && data.reply.trim()) ||
        (data?.error ? `Oops: ${data.error}` : "Bujhlam na—abar bolben? 🙂");
      setMessages((m) => [...m, { role: "model", text: reply, t: Date.now() }]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "model", text: "Net e jhamela hocche. Ektu pore try koren 🙂", t: Date.now() },
      ]);
    } finally {
      setLoading(false);
      taRef.current?.focus();
    }
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div style={sx.page}>
      <div style={sx.card}>
        <Header />
        <div ref={listRef} style={sx.messages}>
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} text={m.text} time={fmt(m.t)} />
          ))}
          {loading && <Typing />}
        </div>
        <div style={sx.inputRow}>
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type here… (Banglish e bolo) ✍️"
            style={sx.input}
            rows={1}
          />
          <button onClick={send} style={sx.btn} disabled={loading || !input.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header style={sx.header}>
      <div style={sx.brand}>
        <div style={sx.logo}>S</div>
        <div>
          <div style={sx.title}>Sadia</div>
          <div style={sx.subtitle}>Banglish Gen-Z chat</div>
        </div>
      </div>
      <div style={sx.badge}>online</div>
    </header>
  );
}

function Bubble({ role, text, time }) {
  const isUser = role === "user";
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-end", alignSelf: isUser ? "flex-end" : "flex-start" }}>
      {!isUser && <Avatar label="S" />}
      <div
        style={{
          ...sx.bubble,
          background: isUser
            ? "linear-gradient(135deg,#3b82f6,#1e40af)"
            : "linear-gradient(135deg,#0ea5e9,#164e63)",
          borderTopRightRadius: isUser ? 6 : 18,
          borderTopLeftRadius: isUser ? 18 : 6,
          color: "white",
        }}
      >
        <div>{text}</div>
        <div style={sx.time}>{time}</div>
      </div>
      {isUser && <Avatar label="🙋" user />}
    </div>
  );
}

function Avatar({ label, user }) {
  return (
    <div
      style={{
        width: 34,
        height: 34,
        borderRadius: "50%",
        background: user ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.08)",
        border: "1px solid rgba(255,255,255,0.16)",
        display: "grid",
        placeItems: "center",
        color: "#fff",
        fontSize: user ? 16 : 14,
        fontWeight: 700,
        flex: "0 0 34px",
      }}
      title={user ? "You" : "Sadia"}
    >
      {label}
    </div>
  );
}

function Typing() {
  return (
    <div style={{ ...sx.bubble, background: "linear-gradient(135deg,#0ea5e9,#164e63)", color: "white", alignSelf: "flex-start" }}>
      <div style={sx.dots}>
        <i style={{ ...sx.dot, animationDelay: "0s" }} />
        <i style={{ ...sx.dot, animationDelay: "0.15s" }} />
        <i style={{ ...sx.dot, animationDelay: "0.3s" }} />
      </div>
      <style>{`
        @keyframes blink {
          0% { opacity: .2; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-2px); }
          100% { opacity: .2; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

const sx = {
  page: {
    minHeight: "100dvh",
    background:
      "radial-gradient(1200px 600px at 10% -10%, rgba(59,130,246,.25), transparent 60%), radial-gradient(900px 500px at 90% 10%, rgba(14,165,233,.20), transparent 60%), linear-gradient(180deg,#0b1220,#0b1220 60%,#0e1628)",
    display: "grid",
    placeItems: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 820,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 20,
    backdropFilter: "blur(8px)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    padding: "14px 16px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: { display: "flex", gap: 12, alignItems: "center" },
  logo: {
    width: 36, height: 36, borderRadius: 12,
    background: "linear-gradient(135deg,#0ea5e9,#2563eb)",
    display: "grid", placeItems: "center",
    color: "#fff", fontWeight: 800,
    boxShadow: "0 8px 18px rgba(14,165,233,.35)",
  },
  title: { fontSize: 18, fontWeight: 800, color: "#fff", letterSpacing: .2 },
  subtitle: { fontSize: 12, color: "#9da3ae" },
  badge: {
    fontSize: 11, color: "#10b981", border: "1px solid rgba(16,185,129,.35)",
    padding: "4px 8px", borderRadius: 999, background: "rgba(16,185,129,.08)",
    textTransform: "uppercase", letterSpacing: 1,
  },
  messages: {
    padding: 16, display: "flex", flexDirection: "column", gap: 12,
    height: "62dvh", overflowY: "auto",
  },
  bubble: {
    position: "relative",
    padding: "10px 12px",
    fontSize: 15,
    lineHeight: 1.55,
    borderRadius: 18,
    maxWidth: "75%",
    wordBreak: "break-word",
    boxShadow: "0 10px 24px rgba(0,0,0,0.25)",
  },
  time: {
    fontSize: 11,
    opacity: .7,
    marginTop: 6,
  },
  dots: { display: "flex", gap: 6, alignItems: "center" },
  dot: {
    width: 7, height: 7, borderRadius: "50%", background: "white",
    display: "inline-block", animation: "blink 1.3s infinite ease-in-out",
  },
  inputRow: {
    display: "flex", gap: 10, padding: 12,
    borderTop: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(0,0,0,.15)",
  },
  input: {
    flex: 1,
    background: "rgba(15,23,42,.75)",
    color: "white",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 14,
    padding: "12px 14px",
    fontSize: 15,
    outline: "none",
    resize: "none",
    maxHeight: 160,
  },
  btn: {
    background: "linear-gradient(135deg,#3b82f6,#1e40af)",
    color: "white",
    border: "none",
    borderRadius: 12,
    padding: "12px 16px",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 10px 24px rgba(59,130,246,.35)",
  },
};
