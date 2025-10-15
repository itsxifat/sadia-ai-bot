// app/claim-info/page.jsx
"use client";
import { useEffect, useState } from "react";

export default function ClaimInfoPage() {
  const [name, setName] = useState("");
  const [url, setUrl]   = useState("");
  const [msg, setMsg]   = useState("");
  const [t, setT]       = useState("");

  useEffect(() => {
    const u = new URL(window.location.href);
    setT(u.searchParams.get("t") || "");
  }, []);

  async function onSubmit(e){
    e.preventDefault();
    setMsg("");
    const res = await fetch("/api/claim-info/submit", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ t, name, profileUrl: url })
    });
    const j = await res.json().catch(()=> ({}));
    if (!res.ok || !j.ok) { setMsg(j.error || "Failed. Try again."); return; }
    setMsg("Saved! You can close this window.");
    try { window.MessengerExtensions?.requestCloseBrowser?.(()=>{},()=>{}); } catch {}
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-md bg-neutral-900 p-5 rounded-xl border border-neutral-800 space-y-4">
        <h1 className="text-lg font-semibold">Share your details</h1>
        <div>
          <label className="block text-sm text-neutral-300 mb-1">Your name</label>
          <input value={name} onChange={e=>setName(e.target.value)} maxLength={80} required
            placeholder="e.g., Rahim Uddin"
            className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-700 focus:outline-none" />
        </div>
        <div>
          <label className="block text-sm text-neutral-300 mb-1">Profile URL</label>
          <input value={url} onChange={e=>setUrl(e.target.value)} required
            placeholder="https://facebook.com/your.profile"
            className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-700 focus:outline-none" />
        </div>
        {msg && <div className="text-sm text-emerald-300">{msg}</div>}
        <button type="submit" className="w-full px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-500">Save</button>
      </form>
      <script src="https://connect.facebook.net/en_US/messenger.Extensions.js" async defer></script>
    </main>
  );
}
