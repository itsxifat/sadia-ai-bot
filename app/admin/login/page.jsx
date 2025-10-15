"use client";
import { useState } from "react";

export default function AdminLoginPage() {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const next = typeof window !== "undefined" ? (new URLSearchParams(window.location.search).get("next") || "/admin") : "/admin";

  async function onSubmit(e){
    e.preventDefault();
    setErr("");
    const res = await fetch("/api/admin/login", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ password }) });
    if (res.ok) window.location.href = next;
    else setErr("Wrong password");
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-200">
      <form onSubmit={onSubmit} className="w-full max-w-sm p-6 rounded-2xl bg-neutral-900 shadow-lg">
        <h1 className="text-xl font-semibold mb-4">Admin Login</h1>
        <input
          type="password"
          className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-700 focus:outline-none mb-2"
          placeholder="Admin password"
          value={password} onChange={e=>setPassword(e.target.value)}
        />
        {err && <p className="text-red-400 text-sm mb-2">{err}</p>}
        <button className="w-full py-2 rounded bg-emerald-600 hover:bg-emerald-500">Sign in</button>
      </form>
    </main>
  );
}
