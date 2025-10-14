// app/chat/page.jsx
"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import * as THREE from "three";

/**
 * ChatPage — ultra-refined (App Router)
 * - Avatar uses /profile.jpg with fallback to /profile.jpeg
 * - Input: pill, focus glow, 6-line autosize cap w/ internal scrollbar, disabled+loading states
 * - Bubbles: consistent radii, sheen, selectable text, wrap fixes
 * - Background: holographic ink-flow shader + scanlines + grain (reduced-motion safe)
 * - A11y: role=log, aria-busy, labeled input
 */

const API_BASE = process.env.NEXT_PUBLIC_CHAT_API_BASE?.trim() || "/api/chat";
const API_TOKEN = process.env.NEXT_PUBLIC_CHAT_API_TOKEN?.trim() || "";

export default function ChatPage() {
  const [messages, setMessages] = useState([
    { role: "model", text: "Ami Sadia 😌—bolo, ki khobor?", t: Date.now() },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const listRef = useRef(null);
  const taRef = useRef(null);
  const headerRef = useRef(null);
  const cardRef = useRef(null);
  const sendBtnRef = useRef(null);
  const pageRef = useRef(null);

  const prefersReduced = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    []
  );

  // Auto-scroll on new messages
  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading]);

  const fmt = (ms) =>
    new Intl.DateTimeFormat("bn-BD", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));

  // Page entrance
  useLayoutEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from(cardRef.current, {
        y: 26,
        opacity: 0,
        duration: 0.8,
        ease: "power3.out",
      });
      gsap.from(headerRef.current?.querySelectorAll("[data-spring]"), {
        y: 12,
        opacity: 0,
        duration: 0.6,
        ease: "power3.out",
        stagger: 0.05,
        delay: 0.05,
      });
    }, pageRef);
    return () => ctx.revert();
  }, []);

  // Autosize textarea (hard cap + stable scrollbar inside)
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;

    // get effective line-height to compute a sensible cap (≈6 lines)
    const cs = window.getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize) || 15;
    let lineHeight = parseFloat(cs.lineHeight);
    if (Number.isNaN(lineHeight)) lineHeight = fontSize * 1.5;
    const MAX = Math.round(lineHeight * 6); // cap at ~6 lines

    el.style.height = "0px"; // reset first to measure scrollHeight accurately
    const next = Math.min(el.scrollHeight, MAX);
    el.style.height = next + "px";
    el.style.overflowY = el.scrollHeight > MAX ? "auto" : "hidden";
  }, [input]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    setError("");
    if (sendBtnRef.current)
      gsap.fromTo(
        sendBtnRef.current,
        { scale: 0.98 },
        { scale: 1, duration: 0.18, ease: "power2.out" }
      );

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
      setMessages((m) => [
        ...m,
        { role: "model", text: reply, t: Date.now() },
      ]);
    } catch (e) {
      setError("Network issue. Try again.");
      gsap.fromTo(
        "#input-row",
        { x: -6 },
        { x: 0, duration: 0.4, ease: "elastic.out(1, .4)" }
      );
      setMessages((m) => [
        ...m,
        {
          role: "model",
          text: "Net e jhamela hocche. Ektu pore try koren 🙂",
          t: Date.now(),
        },
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
    <div ref={pageRef} style={sx.page}>
      <BackgroundInkFlow reduced={prefersReduced} />

      <div ref={cardRef} style={sx.card}>
        <Header refEl={headerRef} />

        <div
          ref={listRef}
          style={sx.messages}
          id="chat-scroll"
          role="log"
          aria-live="polite"
          aria-busy={loading}
        >
          {messages.map((m, i) => (
            <Bubble
              key={i}
              role={m.role}
              text={m.text}
              time={fmt(m.t)}
              reduced={prefersReduced}
            />
          ))}
          {loading && <Typing reduced={prefersReduced} />}
        </div>

        {error && <div style={sx.errorBar}>{error}</div>}

        <div id="input-row" style={sx.inputRow}>
          <label style={sx.visuallyHidden} htmlFor="chat-input">
            Message
          </label>
          <div style={sx.inputShell} className="input-shell">
            <textarea
              id="chat-input"
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="Type here… Shift+Enter = newline"
              style={sx.input}
              rows={1}
              // prevent grammar extensions from injecting overlay buttons that break layout
              data-gramm="false"
              data-gramm_editor="false"
              data-lt-active="false"
              spellCheck={true}
            />
            <div style={sx.inputFx} className="input-fx" aria-hidden />
          </div>
          <button
            ref={sendBtnRef}
            onClick={send}
            style={{ ...sx.btn, ...(loading || !input.trim() ? sx.btnDisabled : null) }}
            disabled={loading || !input.trim()}
            onMouseEnter={(e) =>
              !prefersReduced &&
              gsap.to(e.currentTarget, { y: -2, duration: 0.18, ease: "power2.out" })
            }
            onMouseLeave={(e) =>
              !prefersReduced && gsap.to(e.currentTarget, { y: 0, duration: 0.18 })
            }
          >
            {loading ? (
              <span style={sx.spinner} aria-hidden />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M3 11L21 3L13 21L11 13L3 11Z" stroke="white" strokeWidth="1.6" />
              </svg>
            )}
            <span>{loading ? "Sending…" : "Send"}</span>
          </button>
        </div>
      </div>

      <style>{`
        /* chat list scroll */
        #chat-scroll{scrollbar-width:thin}
        #chat-scroll::-webkit-scrollbar{width:8px;height:8px}
        #chat-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:999px}

        /* textarea internal scrollbar stays inside the pill */
        #chat-input::-webkit-scrollbar{width:8px}
        #chat-input::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:999px}

        @media (max-width: 520px){ 
          #chat-scroll::-webkit-scrollbar{width:5px} 
          #chat-input::-webkit-scrollbar{width:6px}
        }
      `}</style>
    </div>
  );
}

function Header({ refEl }) {
  const [src, setSrc] = useState("/profile.jpg");
  useEffect(() => {
    const img = new Image();
    img.onerror = () => setSrc("/profile.jpeg");
    img.src = "/profile.jpg";
  }, []);
  return (
    <header ref={refEl} style={sx.header}>
      <div style={sx.brand}>
        <div data-spring style={sx.logoWrap}>
          <img src={src} alt="Sadia" style={sx.logoImg} />
          <span style={sx.logoRing} aria-hidden />
        </div>
        <div>
          <div data-spring style={sx.title}>Sadia</div>
          <div data-spring style={sx.subtitle}>Banglish Gen-Z chat</div>
        </div>
      </div>
      <div data-spring style={sx.badgeWrap}>
        <span style={sx.badgeDot} />
        <span style={sx.badge}>online</span>
      </div>
    </header>
  );
}

function Bubble({ role, text, time, reduced }) {
  const isUser = role === "user";
  const wrapRef = useRef(null);
  const bubbleRef = useRef(null);

  useLayoutEffect(() => {
    if (reduced) return;
    const ctx = gsap.context(() => {
      gsap.from(wrapRef.current, { y: 10, opacity: 0, duration: 0.34, ease: "power2.out" });
      gsap.fromTo(
        bubbleRef.current,
        { filter: "blur(6px)", clipPath: "inset(0 100% 0 0)" },
        { filter: "blur(0px)", clipPath: "inset(0 0% 0 0)", duration: 0.38, ease: "power2.out" }
      );
    });
    return () => ctx.revert();
  }, [reduced]);

  return (
    <div
      ref={wrapRef}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-end",
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "100%",
      }}
    >
      {!isUser && (
        <div title="Sadia" style={sx.avatarWrap}>
          <img
            src="/profile.jpg"
            alt="Sadia"
            style={sx.avatarImg}
            onError={(e) => (e.currentTarget.src = "/profile.jpeg")}
          />
        </div>
      )}
      <div
        ref={bubbleRef}
        style={{
          ...sx.bubble,
          background: isUser
            ? "linear-gradient(135deg,#3b82f6,#1e40af)"
            : "linear-gradient(135deg,#0ea5e9,#164e63)",
          borderTopRightRadius: isUser ? 6 : 18,
          borderTopLeftRadius: isUser ? 18 : 6,
          color: "white",
          position: "relative",
          overflow: "hidden",
          WebkitUserSelect: "text",
          userSelect: "text",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
        }}
      >
        <span aria-hidden style={sx.sheen} />
        <div>{text}</div>
        <div style={sx.time}>{time}</div>
      </div>
      {isUser && <div title="You" style={sx.userAvatar}>🙋</div>}
    </div>
  );
}

function Typing({ reduced }) {
  const dotsRef = useRef(null);
  useLayoutEffect(() => {
    if (reduced) return;
    const ctx = gsap.context(() => {
      const dots = dotsRef.current?.querySelectorAll("i");
      gsap.to(dots, {
        keyframes: [{ y: -2, opacity: 1 }, { y: 0, opacity: 0.5 }],
        repeat: -1,
        ease: "sine.inOut",
        duration: 0.9,
        stagger: 0.12,
      });
    });
    return () => ctx.revert();
  }, [reduced]);

  return (
    <div style={{ ...sx.bubble, background: "linear-gradient(135deg,#0ea5e9,#164e63)", color: "white", alignSelf: "flex-start" }}>
      <div ref={dotsRef} style={sx.dots}>
        <i style={sx.dot} />
        <i style={sx.dot} />
        <i style={sx.dot} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Background — Holographic Ink Flow Shader + scanlines + grain overlay
// ────────────────────────────────────────────────────────────────────────────
function BackgroundInkFlow({ reduced }) {
  const containerRef = useRef(null);
  const rafRef = useRef(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || reduced) return;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(container.clientWidth, container.clientHeight) },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position,1.0);} `,
      fragmentShader: /* glsl */ `
        precision highp float; varying vec2 vUv; uniform float uTime; uniform vec2 uResolution; uniform vec2 uMouse;
        vec3 palette(float t){ return mix(vec3(0.06,0.20,0.50), vec3(0.70,0.55,0.98), smoothstep(0.0,1.0,t)); }
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){ vec2 i=floor(p), f=fract(p); float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.)); vec2 u=f*f*(3.-2.*f); return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y; }
        float fbm(vec2 p){ float v=0., a=.5; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<5;i++){ v+=a*noise(p); p=m*p; a*=.5;} return v; }
        void main(){
          vec2 uv=vUv; vec2 p=(uv-.5)*vec2(uResolution.x/uResolution.y,1.);
          p += (uMouse-.5)*.12; float t=uTime*.06; float n=fbm(p*2.+t); float n2=fbm((p+vec2(.5,-.3))*3.-t*.6);
          float m=smoothstep(.2,.9,n*.7+n2*.6); vec3 col=palette(m); col += .08*vec3(smoothstep(.6,1.,m));
          float scan = 0.04*sin((uv.y+uv.x*0.1 + t*0.5)*120.0);  // scanlines
          float g = (hash(uv*vec2(uResolution))-.5)*0.06;        // grain
          col += vec3(scan + g);
          gl_FragColor = vec4(col*.82, .9);
        }
      `,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(quad);

    const onResize = () => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      uniforms.uResolution.value.set(container.clientWidth, container.clientHeight);
    };
    const onPointer = (e) => {
      const rect = container.getBoundingClientRect();
      uniforms.uMouse.value.set(
        (e.clientX - rect.left) / rect.width,
        1.0 - (e.clientY - rect.top) / rect.height
      );
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointer);

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      uniforms.uTime.value = performance.now() * 0.001;
      renderer.render(scene, camera);
    };
    tick();

    gsap.fromTo(renderer.domElement, { opacity: 0 }, { opacity: 1, duration: 1.0, ease: "power2.out" });

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      renderer.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material.forEach((m) => m.dispose()) : o.material.dispose());
      });
      container.removeChild(renderer.domElement);
    };
  }, [reduced]);

  return <div ref={containerRef} style={sx.bg} aria-hidden />;
}

// ────────────────────────────────────────────────────────────────────────────
// Styles
// ────────────────────────────────────────────────────────────────────────────
const sx = {
  page: {
    minHeight: "100dvh",
    background:
      "radial-gradient(1200px 600px at 10% -10%, rgba(59,130,246,.20), transparent 60%), radial-gradient(900px 500px at 90% 10%, rgba(167,139,250,.18), transparent 60%), linear-gradient(180deg,#0b1220,#0b1220 60%,#0e1628)",
    display: "grid",
    placeItems: "center",
    padding: "clamp(8px, 2.5vw, 20px)",
    position: "relative",
    overflow: "hidden",
  },
  visuallyHidden: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0,0,0,0)",
    whiteSpace: "nowrap",
    border: 0,
  },
  bg: { position: "absolute", inset: 0, zIndex: 0, opacity: 0.9, pointerEvents: "none" },
  card: {
    width: "min(100%, 980px)",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 22,
    backdropFilter: "blur(10px)",
    boxShadow: "0 24px 80px rgba(0,0,0,0.40)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    position: "relative",
    zIndex: 1,
  },
  header: {
    padding: "max(10px, env(safe-area-inset-top)) clamp(12px,2vw,20px) 12px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0))",
  },
  brand: { display: "flex", gap: 12, alignItems: "center" },
  logoWrap: { position: "relative", width: 40, height: 40, borderRadius: 12, overflow: "hidden" },
  logoImg: { width: "100%", height: "100%", objectFit: "cover" },
  logoRing: {
    position: "absolute",
    inset: 0,
    borderRadius: 12,
    boxShadow: "0 0 0 2px rgba(255,255,255,.12), 0 0 24px rgba(59,130,246,.35) inset",
  },
  title: { fontSize: "clamp(16px,2.2vw,20px)", fontWeight: 800, color: "#fff", letterSpacing: 0.2 },
  subtitle: { fontSize: "clamp(11px,1.6vw,12px)", color: "#9da3ae" },
  badgeWrap: { display: "grid", gridAutoFlow: "column", alignItems: "center", gap: 8 },
  badgeDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: "#10b981",
    boxShadow: "0 0 0 0 rgba(16,185,129,.6)",
    animation: "pulseDot 1.8s ease-out infinite",
  },
  badge: {
    fontSize: 11,
    color: "#10b981",
    border: "1px solid rgba(16,185,129,.35)",
    padding: "4px 8px",
    borderRadius: 999,
    background: "rgba(16,185,129,.08)",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  errorBar: { margin: "6px 12px 0", color: "#fecaca", fontSize: 12 },
  messages: {
    padding: "clamp(10px,2vw,16px)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    height: "min(66dvh, 70vh)",
    overflowY: "auto",
  },
  bubble: {
    position: "relative",
    padding: "clamp(9px,1.8vw,12px) clamp(10px,2vw,14px)",
    fontSize: "clamp(14px,1.9vw,15px)",
    lineHeight: 1.55,
    borderRadius: 18,
    maxWidth: "min(78%, 760px)",
    wordBreak: "break-word",
    boxShadow: "0 10px 24px rgba(0,0,0,0.25)",
  },
  sheen: {
    content: "''",
    position: "absolute",
    top: 0,
    left: -80,
    width: 120,
    height: "200%",
    transform: "rotate(25deg)",
    background:
      "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.25), rgba(255,255,255,0))",
    mixBlendMode: "overlay",
    pointerEvents: "none",
    animation: "sheenMove 3.5s ease-in-out infinite",
  },
  time: { fontSize: 11, opacity: 0.7, marginTop: 6 },
  dots: { display: "flex", gap: 6, alignItems: "center" },
  dot: { width: 7, height: 7, borderRadius: "50%", background: "white", display: "inline-block", opacity: 0.5 },
  inputRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 10,
    padding: "clamp(10px,2vw,14px)",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(0,0,0,.15)",
    alignItems: "end",
  },
  inputShell: {
    position: "relative",
    display: "grid",
    borderRadius: 999,
    overflow: "hidden", // clips scrollbar/overlays
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(15,23,42,.72)",
  },
  inputFx: {
    position: "absolute",
    inset: 0,
    borderRadius: 999,
    boxShadow: "0 0 0 0 rgba(59,130,246,.0)",
    pointerEvents: "none",
  },
  input: {
    width: "100%",
    display: "block",
    boxSizing: "border-box",
    background: "transparent",
    color: "white",
    border: "none",
    padding: "12px 16px",
    fontSize: 15,
    lineHeight: 1.5, // stable line math for autosize
    outline: "none",
    resize: "none",
    maxHeight: 999, // JS enforces cap; keep CSS ceiling generous
    caretColor: "#93c5fd",
    overflowY: "hidden", // toggled to 'auto' by autosize hook once capped
    scrollbarGutter: "stable both-edges",
  },
  btn: {
    display: "inline-grid",
    gridAutoFlow: "column",
    alignItems: "center",
    gap: 8,
    background: "linear-gradient(135deg,#3b82f6,#1e40af)",
    color: "white",
    border: "none",
    borderRadius: 999,
    padding: "12px 18px",
    fontSize: 15,
    fontWeight: 800,
    cursor: "pointer",
    boxShadow: "0 10px 24px rgba(59,130,246,.35)",
    transition: "box-shadow .2s ease, transform .2s ease, opacity .2s ease",
  },
  btnDisabled: { opacity: 0.6, cursor: "not-allowed", filter: "saturate(.8)" },
  spinner: {
    width: 16,
    height: 16,
    border: "2px solid rgba(255,255,255,.5)",
    borderTopColor: "transparent",
    borderRadius: "50%",
    display: "inline-block",
    animation: "spin .9s linear infinite",
  },
  avatarWrap: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.16)",
    boxShadow: "0 0 0 0 rgba(59,130,246,.0), 0 0 0 1px rgba(255,255,255,.06) inset",
  },
  avatarImg: { width: "100%", height: "100%", objectFit: "cover" },
  userAvatar: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.16)",
    display: "grid",
    placeItems: "center",
    color: "#fff",
    fontSize: 16,
    fontWeight: 700,
    flex: "0 0 34px",
  },
};

// Global keyframes
if (typeof window !== "undefined") {
  const id = "__sadia_global_styles";
  if (!document.getElementById(id)) {
    const s = document.createElement("style");
    s.id = id;
    s.textContent = `
      @keyframes pulseDot { 0%{box-shadow:0 0 0 0 rgba(16,185,129,.6)} 70%{box-shadow:0 0 0 10px rgba(16,185,129,0)} 100%{box-shadow:0 0 0 0 rgba(16,185,129,0)} }
      @keyframes sheenMove { 0%{ transform: translateX(-120px) rotate(25deg);} 60%{ transform: translateX(220%) rotate(25deg);} 100%{ transform: translateX(220%) rotate(25deg);} }
      @keyframes spin { to{ transform: rotate(360deg);} }
      .input-shell:focus-within .input-fx{ box-shadow: 0 0 0 1px rgba(59,130,246,.55), 0 0 24px rgba(59,130,246,.25) }
    `;
    document.head.appendChild(s);
  }
}
