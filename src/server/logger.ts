import pino from "pino";
import { env } from "./config.js";

export const logger = pino({
  level: env.nodeEnv === "development" ? "debug" : "info",
  redact: {
    paths: [
      "req.url",
      "req.originalUrl",
      "req.headers.cookie",
      "req.headers.authorization",
      "req.headers.x-csrf-token",
      "password",
      "passwordHash",
      "token",
      "stripeSecretKey",
      "stripeWebhookSecret",
      "resendApiKey",
    ],
    censor: "[REDACTED]",
  },
  base: { service: "website-change-monitor" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
