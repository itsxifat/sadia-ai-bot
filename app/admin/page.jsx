"use client";
import { useEffect, useMemo, useState } from "react";

function fmt(ts){
  try{
    return new Intl.DateTimeFormat("bn-BD", { timeZone:"Asia/Dhaka", year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit" }).format(new Date(ts));
  }catch{
    return new Date(ts).toLocaleString();
  }
}

export default function AdminHome() {
  const [claims, setClaims] = useState([]);
  const [users, setUsers] = useState([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

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

  useEffect(() => { load(); }, []); // initial
  useEffect(() => { const t=setTimeout(load, 350); return ()=>clearTimeout(t); }, [q]);

  async function setVerified(psid, verified) {
    await fetch("/api/admin/users", {
      method: "POST", headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ psid, verified })
    });
    await load();
  }

  async function logout(){
    await fetch("/api/admin/logout", { method:"POST" });
    window.location.href = "/admin/login";
  }

  const pendingClaims = useMemo(() => (claims || []).filter(x => !x.verified), [claims]);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-200 p-6">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-semibold">Sadia Admin</h1>
        <div className="ml-auto flex items-center gap-2">
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search users…" className="px-3 py-1.5 rounded bg-neutral-900 border border-neutral-700 focus:outline-none" />
          <button onClick={load} className="px-3 py-1.5 rounded bg-neutral-700 hover:bg-neutral-600">Refresh</button>
          <button onClick={logout} className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500">Logout</button>
        </div>
      </div>

      {/* Claims queue */}
      <section className="mb-8">
        <h2 className="text-lg font-medium mb-3">Follow Verify Requests</h2>
        {loading ? <p>Loading…</p> : (
          <div className="overflow-x-auto border border-neutral-800 rounded-xl">
            <table className="min-w-[800px] w-full text-sm">
              <thead className="bg-neutral-900">
                <tr>
                  <th className="text-left p-3">User</th>
                  <th className="text-left p-3">PSID</th>
                  <th className="text-left p-3">Claimed At</th>
                  <th className="text-left p-3">Verified</th>
                  <th className="text-left p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingClaims.length === 0 && (
                  <tr><td colSpan={5} className="p-4 text-neutral-400">No pending claims.</td></tr>
                )}
                {pendingClaims.map(u => (
                  <tr key={u.psid} className="border-t border-neutral-800">
                    <td className="p-3">
                      <div className="flex items-center gap-3">
                        {u.picture && <img src={u.picture} alt="" className="w-8 h-8 rounded-full" />}
                        <div>
                          <div className="font-medium">{u.name || "Unknown"}</div>
                          <div className="text-xs text-neutral-400">{u.locale || ""}</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-3">{u.psid}</td>
                    <td className="p-3">{u.followClaimAt ? fmt(u.followClaimAt) : "-"}</td>
                    <td className="p-3">{u.verified ? "Yes" : "No"}</td>
                    <td className="p-3">
                      <button onClick={()=>setVerified(u.psid, true)} className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500">Verify</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Users list */}
      <section>
        <h2 className="text-lg font-medium mb-3">All Users</h2>
        {loading ? <p>Loading…</p> : (
          <div className="overflow-x-auto border border-neutral-800 rounded-xl">
            <table className="min-w-[900px] w-full text-sm">
              <thead className="bg-neutral-900">
                <tr>
                  <th className="text-left p-3">User</th>
                  <th className="text-left p-3">PSID</th>
                  <th className="text-left p-3">Free Used</th>
                  <th className="text-left p-3">Follow Claim</th>
                  <th className="text-left p-3">Updated</th>
                  <th className="text-left p-3">Verified</th>
                  <th className="text-left p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(users || []).map(u => (
                  <tr key={u.psid} className="border-t border-neutral-800">
                    <td className="p-3">
                      <div className="flex items-center gap-3">
                        {u.picture && <img src={u.picture} alt="" className="w-8 h-8 rounded-full" />}
                        <div>
                          <div className="font-medium">{u.name || "Unknown"}</div>
                          <div className="text-xs text-neutral-400">{u.locale || ""}</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-3">{u.psid}</td>
                    <td className="p-3">{u.freeCount || 0}</td>
                    <td className="p-3">{u.followClaim || "unknown"}</td>
                    <td className="p-3">{u.updatedAt ? fmt(u.updatedAt) : "-"}</td>
                    <td className="p-3">{u.verified ? "Yes" : "No"}</td>
                    <td className="p-3 space-x-2">
                      <button onClick={()=>setVerified(u.psid, true)} className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500">Verify</button>
                      <button onClick={()=>setVerified(u.psid, false)} className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500">Unverify</button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td colSpan={7} className="p-4 text-neutral-400">No users yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
