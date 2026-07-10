"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisClient = void 0;
exports.connectRedis = connectRedis;
exports.cacheGet = cacheGet;
exports.cacheSet = cacheSet;
exports.cacheDel = cacheDel;
exports.cacheDelPattern = cacheDelPattern;
const redis_1 = require("redis");
const logger_1 = require("./logger");
let redisDownLogged = false;
exports.redisClient = (0, redis_1.createClient)({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
});
exports.redisClient.on("error", (err) => {
    if (!redisDownLogged) {
        logger_1.logger.warn(`Redis connection error (non-fatal): ${err.message}`);
        redisDownLogged = true;
    }
});
exports.redisClient.on("connect", () => {
    redisDownLogged = false;
    logger_1.logger.info("✅ Redis reconnected");
});
const delay = (ms) => new Promise(res => setTimeout(res, ms));
async function connectRedis() {
    try {
        await exports.redisClient.connect();
        logger_1.logger.info("✅ Redis connected");
    }
    catch (err) {
        logger_1.logger.warn("Redis not available at startup (continuing without cache)");
    }
}
async function cacheGet(key) {
    try {
        return await exports.redisClient.get(key);
    }
    catch {
        return null;
    }
}
async function cacheSet(key, value, ttlSeconds = 300) {
    try {
        await exports.redisClient.setEx(key, ttlSeconds, value);
    }
    catch { /* ignore */ }
}
async function cacheDel(key) {
    try {
        await exports.redisClient.del(key);
    }
    catch { /* ignore */ }
}
async function cacheDelPattern(pattern) {
    try {
        const keys = await exports.redisClient.keys(pattern);
        if (keys.length)
            await exports.redisClient.del(keys);
    }
    catch { /* ignore */ }
}
