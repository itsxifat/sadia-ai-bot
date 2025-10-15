// app/lib/user-gate.js
import { usersCol } from "./mongo.js";

export async function touchAndGateUser(psid) {
  const col = await usersCol();
  const now = Date.now();

  let user = await col.findOne({ psid });
  if (!user) {
    await col.updateOne(
      { psid },
      { $setOnInsert: { psid, freeCount: 0, dailyCount: 0, verified: false, vip: false, banned: false, isAdmin: false, updatedAt: now } },
      { upsert: true }
    );
    user = await col.findOne({ psid });
  }

  // hard block if banned
  if (user.banned) {
    await col.updateOne({ psid }, { $set: { updatedAt: now } });
    return { user, allowLLM: false, reason: "banned" };
  }

  // reset daily at Dhaka midnight
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
  const last  = user.dailyAt ? new Date(user.dailyAt).toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" }) : null;
  if (today !== last) {
    await col.updateOne({ psid }, { $set: { dailyCount: 0, dailyAt: now } });
    user = { ...user, dailyCount: 0, dailyAt: now };
  }

  if (user.vip) {
    await col.updateOne({ psid }, { $set: { updatedAt: now } });
    return { user: { ...user, vip: true }, allowLLM: true, reason: "vip" };
  }

  if (!user.verified) {
    if ((user.freeCount || 0) >= 10) {
      await col.updateOne({ psid }, { $set: { updatedAt: now } });
      return { user, allowLLM: false, reason: "need_follow" };
    }
    const next = (user.freeCount || 0) + 1;
    await col.updateOne({ psid }, { $set: { updatedAt: now, freeCount: next } });
    return { user: { ...user, freeCount: next }, allowLLM: true, reason: "ok" };
  }

  if ((user.dailyCount || 0) >= 100) {
    await col.updateOne({ psid }, { $set: { updatedAt: now } });
    return { user, allowLLM: false, reason: "daily_limit" };
  }
  const nextDaily = (user.dailyCount || 0) + 1;
  await col.updateOne({ psid }, { $set: { updatedAt: now, dailyCount: nextDaily } });
  return { user: { ...user, dailyCount: nextDaily }, allowLLM: true, reason: "ok" };
}
