// app/lib/user-gate.js
import { usersCol } from "../lib/mongo.js";

/**
 * Ensures a user row exists, handles counters/limits,
 * and decides whether we should pass the message to the LLM.
 *
 * Returns:
 *  {
 *    user,                // the user document (after update)
 *    allowLLM,            // boolean - should we call generateReplyLLM?
 *    reason,              // 'ok' | 'need_follow' | 'daily_limit' | 'vip'
 *  }
 */
export async function touchAndGateUser(psid) {
  const col = await usersCol();

  // Upsert skeleton row
  const now = Date.now();
  let user = await col.findOne({ psid });
  if (!user) {
    await col.updateOne(
      { psid },
      { $setOnInsert: { psid, freeCount: 0, dailyCount: 0, verified: false, vip: false, updatedAt: now } },
      { upsert: true }
    );
    user = await col.findOne({ psid });
  }

  // Reset daily counter if day changed (Asia/Dhaka midnight)
  const dhakaNow = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
  const lastDay  = user.dailyAt
    ? new Date(user.dailyAt).toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" })
    : null;
  if (lastDay !== dhakaNow) {
    await col.updateOne({ psid }, { $set: { dailyCount: 0, dailyAt: now } });
    user = { ...user, dailyCount: 0, dailyAt: now };
  }

  // VIP → always allowed
  if (user.vip) {
    await col.updateOne({ psid }, { $set: { updatedAt: now } });
    return { user: { ...user, vip: true }, allowLLM: true, reason: "vip" };
  }

  // Not verified:
  if (!user.verified) {
    const maxFree = 10;
    if ((user.freeCount || 0) >= maxFree) {
      // Over free limit → block LLM
      await col.updateOne({ psid }, { $set: { updatedAt: now } });
      return { user, allowLLM: false, reason: "need_follow" };
    }
    // Under free limit → increment freeCount and allow LLM
    const next = (user.freeCount || 0) + 1;
    await col.updateOne({ psid }, { $set: { updatedAt: now, freeCount: next } });
    return { user: { ...user, freeCount: next }, allowLLM: true, reason: "ok" };
  }

  // Verified (non-VIP): daily limit 100
  const maxDaily = 100;
  if ((user.dailyCount || 0) >= maxDaily) {
    await col.updateOne({ psid }, { $set: { updatedAt: now } });
    return { user, allowLLM: false, reason: "daily_limit" };
  }
  // Increment dailyCount
  const nextDaily = (user.dailyCount || 0) + 1;
  await col.updateOne({ psid }, { $set: { updatedAt: now, dailyCount: nextDaily } });
  return { user: { ...user, dailyCount: nextDaily }, allowLLM: true, reason: "ok" };
}
