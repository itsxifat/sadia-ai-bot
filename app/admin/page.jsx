"use client";

import { useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import gsap from "gsap";

function fmt(ts){
  try{
    return new Intl.DateTimeFormat("bn-BD",{ timeZone:"Asia/Dhaka", year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit" }).format(new Date(ts));
  }catch{return new Date(ts).toLocaleString();}
}

export default function AdminHome() {
  const [claims, setClaims] = useState([]);
  const [users, setUsers]   = useState([]);
  const [q, setQ]           = useState("");
  const [loading, setLoading]= useState(true);

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

  async function patchUser(psid, body) {
    await fetch("/api/admin/users", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ psid, ...body }) });
    await load();
  }
  async function refreshProfile(psid){
    await fetch("/api/admin/refresh-profile", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ psid }) });
    await load();
  }
  async function logout(){ await fetch("/api/admin/logout", { method:"POST" }); window.location.href="/admin/login"; }

  const pendingClaims = useMemo(()=> (claims||[]).filter(x => !x.verified), [claims]);

  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults:{ ease:"power2.out", duration:0.6 }});
      tl.from(headerRef.current, { y: -12, opacity: 0 })
        .from(toolsRef.current,  { y:  12, opacity: 0 }, "-=0.3");
    }, rootRef);
    return () => ctx.revert();
  }, []);

  useEffect(() => {
    if (loading) return;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const playStagger = (els, dy=8, delay=0.04) => {
      if (!els?.length) return;
      gsap.fromTo(els, { y: dy, opacity: 0 }, { y: 0, opacity: 1, duration: prefersReduced ? 0.01 : 0.45, stagger: prefersReduced ? 0 : delay, ease:"power2.out" });
    };
    playStagger(claimRowRefs.current, 8, 0.05);
    playStagger(userRowRefs.current,  8, 0.02);
  }, [loading, claims, users]);

  useEffect(() => {
    if (!searchRef.current) return;
    const el = searchRef.current;
    const onFocus = () => gsap.to(el, { boxShadow: "0 0 0 3px rgba(16,185,129,0.3)", duration:0.25 });
    const onBlur  = () => gsap.to(el, { boxShadow: "0 0 0 0 rgba(0,0,0,0)",     duration:0.25 });
    el.addEventListener("focus", onFocus); el.addEventListener("blur", onBlur);
    return () => { el.removeEventListener("focus", onFocus); el.removeEventListener("blur", onBlur); };
  }, []);

  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    const down = e => { const b = e.target.closest("button"); if (!b) return; gsap.to(b, { y:1, scale:0.985, duration:0.08 }); };
    const up   = e => { const b = e.target.closest("button"); if (!b) return; gsap.to(b, { y:0, scale:1,    duration:0.15 }); };
    root.addEventListener("pointerdown", down); root.addEventListener("pointerup", up); root.addEventListener("pointerleave", up);
    return () => { root.removeEventListener("pointerdown", down); root.removeEventListener("pointerup", up); root.removeEventListener("pointerleave", up); };
  }, []);

  const SkeletonRow = ({ cols=5 }) => (
    <tr className="border-t border-neutral-900"><td className="p-3" colSpan={cols}><div className="animate-pulse h-6 w-full rounded bg-neutral-800/60" /></td></tr>
  );

  const Avatar = ({ u }) => (
    u.picture ? (
      <img src={u.picture} alt="" className="w-8 h-8 rounded-full ring-1 ring-neutral-800" />
    ) : (
      <div className="w-8 h-8 rounded-full bg-neutral-800/80 flex items-center justify-center text-xs text-neutral-400">
        {(u.name && u.name.trim() !== "Unknown") ? u.name.split(" ").map(s=>s[0]).join("").slice(0,2).toUpperCase() : "?"}
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
          <input ref={searchRef} value={q} onChange={e=>setQ(e.target.value)} placeholder="Search users…" className="px-3 py-1.5 rounded bg-neutral-900 border border-neutral-700 focus:outline-none" />
          <button onClick={load} className="px-3 py-1.5 rounded bg-neutral-700 hover:bg-neutral-600">Refresh</button>
          <button onClick={logout} className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500">Logout</button>
        </div>
      </div>

      {/* Claims */}
      <section className="mb-10">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-medium">Follow Verify Requests</h2>
          {!loading && <span className="text-xs text-neutral-400">{(claims||[]).filter(x=>!x.verified).length} pending</span>}
        </div>
        <div className="overflow-x-auto border border-neutral-800 rounded-xl shadow-[0_0_0_1px_rgba(255,255,255,0.03)_inset]">
          <table className="min-w-[900px] w-full text-sm">
            <thead className="bg-neutral-900/80 backdrop-blur">
              <tr>
                <th className="text-left p-3">User</th><th className="text-left p-3">PSID</th><th className="text-left p-3">Claimed At</th><th className="text-left p-3">Verified</th><th className="text-left p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (<><SkeletonRow cols={5}/><SkeletonRow cols={5}/><SkeletonRow cols={5}/></>)}
              {!loading && (claims||[]).filter(x=>!x.verified).length === 0 && (
                <tr><td colSpan={5} className="p-4 text-neutral-400">No pending claims.</td></tr>
              )}
              {!loading && (claims||[]).filter(x=>!x.verified).map(u => (
                <tr key={u.psid} ref={addClaimRowRef} className="border-t border-neutral-800">
                  <td className="p-3">
                    <div className="flex items-center gap-3"><Avatar u={u}/><div><div className="font-medium">{u.name || "Unknown"}</div><div className="text-xs text-neutral-400">{u.locale || ""}</div></div></div>
                  </td>
                  <td className="p-3">{u.psid}</td>
                  <td className="p-3">{u.followClaimAt ? fmt(u.followClaimAt) : "-"}</td>
                  <td className="p-3">{u.verified ? "Yes" : "No"}</td>
                  <td className="p-3 space-x-2">
                    <button onClick={()=>patchUser(u.psid, { verified: true })} className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500">Verify</button>
                    <button onClick={()=>refreshProfile(u.psid)} className="px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600">Refresh Profile</button>
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
          {!loading && <span className="text-xs text-neutral-400">{users.length} total</span>}
        </div>
        <div className="overflow-x-auto border border-neutral-800 rounded-xl shadow-[0_0_0_1px_rgba(255,255,255,0.03)_inset]">
          <table className="min-w-[1100px] w-full text-sm">
            <thead className="bg-neutral-900/80 backdrop-blur">
              <tr>
                <th className="text-left p-3">User</th><th className="text-left p-3">PSID</th><th className="text-left p-3">Free Used</th><th className="text-left p-3">Daily Used</th><th className="text-left p-3">Follow Claim</th><th className="text-left p-3">Verified</th><th className="text-left p-3">VIP</th><th className="text-left p-3">Updated</th><th className="text-left p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (<><SkeletonRow cols={9}/><SkeletonRow cols={9}/><SkeletonRow cols={9}/><SkeletonRow cols={9}/></>)}
              {!loading && users.length === 0 && <tr><td colSpan={9} className="p-4 text-neutral-400">No users yet.</td></tr>}
              {!loading && users.map(u => (
                <tr key={u.psid} ref={addUserRowRef} className="border-t border-neutral-800">
                  <td className="p-3">
                    <div className="flex items-center gap-3"><Avatar u={u}/><div><div className="font-medium">{u.name || "Unknown"}</div><div className="text-xs text-neutral-400">{u.locale || ""}</div></div></div>
                  </td>
                  <td className="p-3">{u.psid}</td>
                  <td className="p-3">{u.freeCount || 0}</td>
                  <td className="p-3">{u.dailyCount || 0}</td>
                  <td className="p-3">{u.followClaim || "unknown"}</td>
                  <td className="p-3">{u.verified ? "Yes" : "No"}</td>
                  <td className="p-3">{u.vip ? "Yes" : "No"}</td>
                  <td className="p-3">{u.updatedAt ? fmt(u.updatedAt) : "-"}</td>
                  <td className="p-3 space-x-2">
                    <button onClick={()=>patchUser(u.psid, { verified: true })}  className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500">Verify</button>
                    <button onClick={()=>patchUser(u.psid, { verified: false })} className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500">Unverify</button>
                    {!u.vip
                      ? <button onClick={()=>patchUser(u.psid, { vip: true })}  className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500">Make VIP</button>
                      : <button onClick={()=>patchUser(u.psid, { vip: false })} className="px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600">Remove VIP</button>}
                    <button onClick={()=>refreshProfile(u.psid)} className="px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600">Refresh Profile</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
