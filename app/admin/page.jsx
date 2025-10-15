"use client";

import { useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import gsap from "gsap";

function fmt(ts){
  try{
    return new Intl.DateTimeFormat("bn-BD",{ timeZone:"Asia/Dhaka", year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit" }).format(new Date(ts));
  }catch{return new Date(ts).toLocaleString();}
}

function Pill({ children, color="neutral" }) {
  const map = {
    neutral: "bg-neutral-800 text-neutral-300",
    green:   "bg-emerald-900/50 text-emerald-300",
    red:     "bg-rose-900/50 text-rose-300",
    blue:    "bg-sky-900/50 text-sky-300",
    amber:   "bg-amber-900/50 text-amber-200",
  };
  return <span className={`px-2 py-0.5 rounded text-xs ${map[color]}`}>{children}</span>;
}

function Switch({ checked, onChange, label }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <span className="text-xs text-neutral-300">{label}</span>
      <span
        onClick={() => onChange(!checked)}
        className={`w-10 h-6 rounded-full flex items-center transition-colors px-0.5 ${checked ? "bg-emerald-500/80" : "bg-neutral-700"}`}
      >
        <span className={`w-5 h-5 bg-white rounded-full shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`} />
      </span>
    </label>
  );
}

// tiny toast
function useToasts() {
  const [toasts, setToasts] = useState([]);
  function push(msg, tone="ok") {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2000);
  }
  const Toasts = () => (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex flex-col gap-2 z-50">
      {toasts.map(t => (
        <div key={t.id} className={`px-3 py-2 rounded text-sm shadow ${
          t.tone === "err" ? "bg-rose-600/90" : "bg-neutral-800/90"
        }`}>
          {t.msg}
        </div>
      ))}
    </div>
  );
  return { push, Toasts };
}

export default function AdminHome() {
  const [claims, setClaims] = useState([]);
  const [users, setUsers]   = useState([]);
  const [q, setQ]           = useState("");
  const [loading, setLoading]= useState(true);

  const { push, Toasts } = useToasts();

  const rootRef   = useRef(null);
  const headerRef = useRef(null);
  const toolsRef  = useRef(null);
  const claimRowRefs = useRef([]); claimRowRefs.current = [];
  const userRowRefs  = useRef([]); userRowRefs.current  = [];
  const searchRef = useRef(null);

  const addClaimRowRef = el => el && claimRowRefs.current.push(el);
  const addUserRowRef  = el => el && userRowRefs.current.push(el);

  async function load() {
    setLoading(true);
    const [cRes, uRes] = await Promise.all([
      fetch("/api/admin/claims?limit=50", { cache: "no-store" }),
      fetch(`/api/admin/users?limit=50${q ? `&q=${encodeURIComponent(q)}` : ""}`, { cache: "no-store" }),
    ]);
    const c = cRes.ok ? await cRes.json() : { items: [] };
    const u = uRes.ok ? await uRes.json() : { items: [] };
    setClaims(c.items || []);
    setUsers(u.items || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { const t=setTimeout(load, 350); return ()=>clearTimeout(t); }, [q]);

  // optimistic patcher
  async function patchUser(psid, body) {
    setUsers(prev => prev.map(u => u.psid === psid ? { ...u, ...body } : u));
    const res = await fetch("/api/admin/users", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ psid, ...body })
    });
    if (!res.ok) {
      push("Update failed", "err");
      // revert by reloading
      await load();
      return;
    }
    const data = await res.json().catch(()=> ({}));
    if (data?.user) {
      setUsers(prev => prev.map(u => u.psid === psid ? data.user : u));
    } else {
      await load(); // ensure consistency
    }
    push("Saved");
  }

  async function refreshProfile(psid){
    const res = await fetch("/api/admin/refresh-profile", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ psid })
    });
    if (!res.ok) { push("Profile refresh failed", "err"); return; }
    await load();
    push("Profile refreshed");
  }
  async function logout(){ await fetch("/api/admin/logout", { method:"POST" }); window.location.href="/admin/login"; }

  const pendingClaims = useMemo(()=> (claims||[]).filter(x => !x.verified), [claims]);

  // gsap mount
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults:{ ease:"power2.out", duration:0.6 }});
      tl.from(headerRef.current, { y: -12, opacity: 0 })
        .from(toolsRef.current,  { y:  12, opacity: 0 }, "-=0.3");
    }, rootRef);
    return () => ctx.revert();
  }, []);
  // rows reveal
  useEffect(() => {
    if (loading) return;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const play = (els, dy=8, st=0.04) =>
      gsap.fromTo(els, { y: dy, opacity: 0 }, { y:0, opacity:1, duration: prefersReduced?0.01:0.45, stagger: prefersReduced?0:st, ease:"power2.out" });
    play(claimRowRefs.current, 8, 0.05);
    play(userRowRefs.current,  8, 0.02);
  }, [loading, claims, users]);

  // focus glow
  useEffect(() => {
    if (!searchRef.current) return;
    const el = searchRef.current;
    const onFocus = () => gsap.to(el, { boxShadow: "0 0 0 3px rgba(16,185,129,0.3)", duration:0.25 });
    const onBlur  = () => gsap.to(el, { boxShadow: "0 0 0 0 rgba(0,0,0,0)",     duration:0.25 });
    el.addEventListener("focus", onFocus); el.addEventListener("blur", onBlur);
    return () => { el.removeEventListener("focus", onFocus); el.removeEventListener("blur", onBlur); };
  }, []);

  const SkeletonRow = ({ cols=5 }) => (
    <tr className="border-t border-neutral-900">
      <td className="p-3" colSpan={cols}><div className="animate-pulse h-6 w-full rounded bg-neutral-800/60" /></td>
    </tr>
  );

  const Avatar = ({ u }) => (
    u.picture ? (
      <img src={u.picture} alt="" className="w-8 h-8 rounded-full ring-1 ring-neutral-800" />
    ) : (
      <div className="w-8 h-8 rounded-full bg-neutral-800/80 flex items-center justify-center text-xs text-neutral-400">
        {(u.name && u.name.trim() !== "Unknown")
          ? u.name.split(" ").map(s=>s[0]).join("").slice(0,2).toUpperCase()
          : "?"}
      </div>
    )
  );

  return (
    <main ref={rootRef} className="min-h-screen bg-neutral-950 text-neutral-200 p-6">
      <div ref={headerRef} className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Sadia Admin
          <span className="block h-[2px] w-16 bg-gradient-to-r from-emerald-400 to-sky-400 rounded mt-1" />
        </h1>
        <div ref={toolsRef} className="ml-auto flex items-center gap-2">
          <input
            ref={searchRef}
            value={q}
            onChange={e=>setQ(e.target.value)}
            placeholder="Search users…"
            className="px-3 py-1.5 rounded bg-neutral-900 border border-neutral-700 focus:outline-none"
          />
          <button onClick={load} className="px-3 py-1.5 rounded bg-neutral-700 hover:bg-neutral-600">Refresh</button>
          <button onClick={logout} className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500">Logout</button>
        </div>
      </div>

      {/* Claims */}
      <section className="mb-10">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-medium">Follow Verify Requests</h2>
          {!loading && <span className="text-xs text-neutral-400">{pendingClaims.length} pending</span>}
        </div>
        <div className="overflow-x-auto border border-neutral-800 rounded-xl shadow-[0_0_0_1px_rgba(255,255,255,0.03)_inset]">
          <table className="min-w-[900px] w-full text-sm">
            <thead className="bg-neutral-900/80 backdrop-blur">
              <tr>
                <th className="text-left p-3">User</th>
                <th className="text-left p-3">PSID</th>
                <th className="text-left p-3">Claimed At</th>
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (<><SkeletonRow cols={5}/><SkeletonRow cols={5}/><SkeletonRow cols={5}/></>)}
              {!loading && pendingClaims.length === 0 && (
                <tr><td colSpan={5} className="p-4 text-neutral-400">No pending claims.</td></tr>
              )}
              {!loading && pendingClaims.map(u => (
                <tr key={u.psid} ref={addClaimRowRef} className="border-t border-neutral-800">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <Avatar u={u}/>
                      <div>
                        <div className="font-medium">{u.name || "Unknown"}</div>
                        <div className="text-xs text-neutral-400">{u.locale || ""}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3">{u.psid}</td>
                  <td className="p-3">{u.followClaimAt ? fmt(u.followClaimAt) : "-"}</td>
                  <td className="p-3">
                    <div className="flex gap-2">
                      <Pill color={u.verified ? "green":"amber"}>{u.verified ? "Verified":"Pending"}</Pill>
                      {u.vip ? <Pill color="blue">VIP</Pill> : null}
                    </div>
                  </td>
                  <td className="p-3 space-x-3">
                    <Switch
                      checked={!!u.verified}
                      onChange={(v)=>patchUser(u.psid, { verified: v })}
                      label="Verified"
                    />
                    <button onClick={()=>refreshProfile(u.psid)} className="px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600">
                      Refresh Profile
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Users */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-medium">All Users</h2>
        </div>
        <div className="overflow-x-auto border border-neutral-800 rounded-xl shadow-[0_0_0_1px_rgba(255,255,255,0.03)_inset]">
          <table className="min-w-[1100px] w-full text-sm">
            <thead className="bg-neutral-900/80 backdrop-blur">
              <tr>
                <th className="text-left p-3">User</th>
                <th className="text-left p-3">PSID</th>
                <th className="text-left p-3">Free Used</th>
                <th className="text-left p-3">Daily Used</th>
                <th className="text-left p-3">Follow Claim</th>
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">Updated</th>
                <th className="text-left p-3">Controls</th>
              </tr>
            </thead>
            <tbody>
              {loading && (<><SkeletonRow cols={8}/><SkeletonRow cols={8}/><SkeletonRow cols={8}/><SkeletonRow cols={8}/></>)}
              {!loading && users.length === 0 && <tr><td colSpan={8} className="p-4 text-neutral-400">No users yet.</td></tr>}
              {!loading && users.map(u => (
                <tr key={u.psid} ref={addUserRowRef} className="border-t border-neutral-800">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <Avatar u={u}/>
                      <div>
                        <div className="font-medium">{u.name || "Unknown"}</div>
                        <div className="text-xs text-neutral-400">{u.locale || ""}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3">{u.psid}</td>
                  <td className="p-3">{u.freeCount || 0}</td>
                  <td className="p-3">{u.dailyCount || 0}</td>
                  <td className="p-3">{u.followClaim || "unknown"}</td>
                  <td className="p-3">
                    <div className="flex gap-2">
                      <Pill color={u.verified ? "green":"red"}>{u.verified ? "Verified":"Not verified"}</Pill>
                      {u.vip ? <Pill color="blue">VIP</Pill> : null}
                    </div>
                  </td>
                  <td className="p-3">{u.updatedAt ? fmt(u.updatedAt) : "-"}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-4">
                      <Switch
                        checked={!!u.verified}
                        onChange={(v)=>patchUser(u.psid, { verified: v })}
                        label="Verified"
                      />
                      <Switch
                        checked={!!u.vip}
                        onChange={(v)=>patchUser(u.psid, { vip: v })}
                        label="VIP"
                      />
                      <button onClick={()=>refreshProfile(u.psid)} className="px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600">
                        Refresh Profile
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Toasts />
    </main>
  );
}
