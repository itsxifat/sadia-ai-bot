// lib/redis.js
import Redis from "ioredis";

let redis = null;

export async function initRedisOnce() {
  if (redis || !process.env.REDIS_URL) return redis;
  try {
    redis = new Redis(process.env.REDIS_URL, {
      connectTimeout: 10000,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    await redis.connect();
    await redis.ping();
  } catch (err) {
    console.error("Redis connect error:", err?.message || err);
    redis = null;
  }
  return redis;
}

export function getRedis() {
  return redis;
}
