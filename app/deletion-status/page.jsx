// app/deletion-status/page.jsx
"use client";
import { useEffect, useState } from "react";

export default function DeletionStatus() {
  const [code, setCode] = useState("");

  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("code") || "";
    setCode(c);
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-200 p-6">
      <div className="max-w-md w-full bg-neutral-900 p-6 rounded-xl space-y-3">
        <h1 className="text-xl font-semibold">Data Deletion Status</h1>
        <p className="text-sm text-neutral-300">
          Your request has been received and processed. Personal data associated with your Facebook account has been deleted (or anonymized) from our systems.
        </p>
        {code && (
          <p className="text-xs text-neutral-400">
            Confirmation code: <span className="font-mono">{code}</span>
          </p>
        )}
        <p className="text-xs text-neutral-500">
          If you have questions, contact us at the email listed in our Privacy Policy.
        </p>
      </div>
    </main>
  );
}
