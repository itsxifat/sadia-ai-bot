// app/claim/page.jsx (only the relevant additions shown)
"use client";
import { useEffect, useState } from "react";

export default function ClaimPage() {
  const [ok, setOk] = useState(false);
  const [psid, setPsid] = useState("");
  const [err, setErr] = useState("");
  const [t, setT] = useState("");
  const [form, setForm] = useState({ name: "", email: "", photo: "" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const tok = new URLSearchParams(window.location.search).get("t");
    setT(tok || "");
    (async () => {
      try{
        const r = await fetch("/api/claim/validate?t=" + encodeURIComponent(tok), { cache: "no-store" });
        const j = await r.json();
        if (!r.ok || !j?.ok) throw new Error(j?.error || "Invalid link");
        setOk(true); setPsid(j.psid);
      }catch(e){ setErr(e.message || "Invalid link"); }
    })();
  }, []);

  function loginWithFacebook(){
    window.location.href = `/api/auth/facebook/start?t=${encodeURIComponent(t)}`;
  }

  // ... keep your manual form below as a fallback ...

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-950 text-neutral-200">
      <div className="max-w-sm w-full bg-neutral-900 p-5 rounded-xl space-y-3">
        <h1 className="text-xl font-semibold">Verify your chat</h1>
        {err && <p className="text-sm text-rose-400">{err}</p>}
        {ok && <>
          <p className="text-xs text-neutral-400">PSID: {psid}</p>

          {/* Facebook Login CTA */}
          <button onClick={loginWithFacebook}
                  className="w-full py-2 rounded bg-[#1877F2] hover:opacity-90">
            Continue with Facebook
          </button>

          <div className="h-px bg-neutral-800 my-2" />
          <p className="text-xs text-neutral-400">Or fill manually:</p>

          {/* your existing manual form... */}
          <form onSubmit={async (e)=>{ e.preventDefault(); /* your existing /api/claim/complete submit */ }}>
            {/* ... name/email/photo fields as before ... */}
          </form>
        </>}
      </div>
    </main>
  );
}
