import { createClient } from 'redis';
import { logger } from './logger';

let redisDownLogged = false;


export const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
});

redisClient.on("error", (err) => {
  if (!redisDownLogged) {
    logger.warn(`Redis connection error (non-fatal): ${err.message}`);
    redisDownLogged = true;
  }
});
redisClient.on("connect", () => {
  redisDownLogged = false;
  logger.info("✅ Redis reconnected");
});

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export async function connectRedis() {
  try {
    await redisClient.connect();
    logger.info("✅ Redis connected");
  } catch (err: any) {
    logger.warn("Redis not available at startup (continuing without cache)");
  }
}
export async function cacheGet(key: string): Promise<string | null> {
  try { return await redisClient.get(key); } catch { return null; }
}

export async function cacheSet(key: string, value: string, ttlSeconds = 300): Promise<void> {
  try { await redisClient.setEx(key, ttlSeconds, value); } catch { /* ignore */ }
}

export async function cacheDel(key: string): Promise<void> {
  try { await redisClient.del(key); } catch { /* ignore */ }
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length) await redisClient.del(keys);
  } catch { /* ignore */ }
}