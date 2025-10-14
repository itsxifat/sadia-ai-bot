// lib/redis.js
import Redis from "ioredis";

let redis = null;

export async function initRedisOnce() {
  if (redis || !process.env.REDIS_URL) return null;
  try {
    redis = new Redis(process.env.REDIS_URL, {
      tls: process.env.REDIS_URL.startsWith("rediss://") ? {} : undefined,
      password: process.env.REDIS_TOKEN || undefined,
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
    await redis.connect().catch(() => {});
  } catch (_) {
    redis = null;
  }
  return redis;
}

export function getRedis() {
  return redis;
}
