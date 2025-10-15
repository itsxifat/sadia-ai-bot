// app/claim/page.jsx
"use client";
import { useEffect, useState } from "react";

export default function ClaimPage() {
  const [ok, setOk] = useState(false);
  const [psid, setPsid] = useState("");
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ name: "", email: "", photo: "" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t");
    (async () => {
      try{
        const r = await fetch("/api/claim/validate?t=" + encodeURIComponent(t), { cache: "no-store" });
        const j = await r.json();
        if (!r.ok || !j?.ok) throw new Error(j?.error || "Invalid link");
        setOk(true); setPsid(j.psid);
      }catch(e){ setErr(e.message || "Invalid link"); }
    })();
  }, []);

  async function submit(e){
    e.preventDefault();
    setSubmitting(true);
    try{
      const t = new URLSearchParams(window.location.search).get("t");
      const r = await fetch("/api/claim/complete", {
        method: "POST", headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ t, ...form })
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "Failed");
      alert("Verified! You can go back to Messenger now.");
      window.location.href = j.redirect || "https://m.me/";
    }catch(e){ alert(e.message || "Error"); }
    finally{ setSubmitting(false); }
  }

  if (err) return <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-950 text-neutral-200">
    <div className="max-w-sm w-full bg-neutral-900 p-5 rounded-xl">
      <h1 className="text-lg font-semibold mb-2">Invalid or expired link</h1>
      <p className="text-sm text-neutral-400">{err}</p>
    </div>
  </main>;

  if (!ok) return <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-950 text-neutral-200">
    <div className="animate-pulse text-neutral-400">Verifying…</div>
  </main>;

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-950 text-neutral-200">
      <form onSubmit={submit} className="max-w-sm w-full bg-neutral-900 p-5 rounded-xl space-y-3">
        <h1 className="text-xl font-semibold">Verify your chat</h1>
        <p className="text-xs text-neutral-400">PSID: {psid}</p>
        <div>
          <label className="text-sm">Name</label>
          <input required value={form.name} onChange={e=>setForm(v=>({...v, name:e.target.value}))}
                 className="mt-1 w-full px-3 py-2 rounded bg-neutral-800 outline-none" placeholder="Your name" />
        </div>
        <div>
          <label className="text-sm">Email (optional)</label>
          <input type="email" value={form.email} onChange={e=>setForm(v=>({...v, email:e.target.value}))}
                 className="mt-1 w-full px-3 py-2 rounded bg-neutral-800 outline-none" placeholder="you@email.com" />
        </div>
        <div>
          <label className="text-sm">Photo URL (optional)</label>
          <input value={form.photo} onChange={e=>setForm(v=>({...v, photo:e.target.value}))}
                 className="mt-1 w-full px-3 py-2 rounded bg-neutral-800 outline-none" placeholder="https://…" />
        </div>
        <button disabled={submitting} className="w-full py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60">
          {submitting ? "Saving…" : "Verify & Continue"}
        </button>
        <p className="text-xs text-neutral-500">By continuing you allow us to save this info to improve your chat experience.</p>
      </form>
    </main>
  );
}
