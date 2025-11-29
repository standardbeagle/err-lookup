import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export function createRedisConnection(): Redis {
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
  });

  redis.on("error", (error) => {
    console.error("Redis connection error:", error);
  });

  redis.on("connect", () => {
    console.log("Connected to Redis");
  });

  return redis;
}

export const redisConnection = createRedisConnection();
