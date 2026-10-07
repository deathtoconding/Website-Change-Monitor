import express from "express";
import { Redis } from "ioredis";
import { createAuthenticationRateLimiters } from "../src/server/rate-limits.ts";

const redisUrl = process.env.REDIS_TEST_URL;
const port = Number(process.argv[2]);
const namespace = process.argv[3];
if (!redisUrl || !Number.isInteger(port) || !namespace) {
  throw new Error("REDIS_TEST_URL, a port, and a namespace are required.");
}

const redis = new Redis(redisUrl, {
  connectTimeout: 5_000,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
});
redis.on("error", () => {
  process.stderr.write("Redis connection error\n");
});
await redis.connect();
await redis.ping();

const { authLimiter, resetLimiter } = createAuthenticationRateLimiters(
  redis,
  namespace,
);
const app = express();
app.post("/auth-attempt", authLimiter, (_req, res) => res.sendStatus(204));
app.post("/reset-attempt", resetLimiter, (_req, res) => res.sendStatus(204));
app.use((_error, _req, res, _next) => {
  void _next;
  res.status(503).json({ error: "Authentication is temporarily unavailable." });
});

const server = app.listen(port, "127.0.0.1", () => {
  process.stdout.write("READY\n");
});

process.once("SIGTERM", () => {
  server.close(() => {
    void redis.quit().finally(() => process.exit(0));
  });
});
