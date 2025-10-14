import { redirect } from "next/navigation";

export default function Home() {
  redirect("/chat"); // instant server-side redirect
  return null;
}
