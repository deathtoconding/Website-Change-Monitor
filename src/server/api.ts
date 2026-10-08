import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { authRouter } from "./routes/auth.js";
import { monitorRouter } from "./routes/monitors.js";
import { billingRouter, handleStripeWebhook } from "./routes/billing.js";
import { env, assertProductionIntegrationsConfigured } from "./config.js";
import { logger } from "./logger.js";
import { pool, pingDatabase, closeDatabase } from "./db/index.js";
import {
  closeQueues,
  monitorQueue,
  notificationQueue,
  systemNotificationQueue,
  redisControl,
} from "./queue.js";
import { requestIdMiddleware } from "./middleware.js";
import { checkReadiness } from "./readiness.js";
import {
  incrementMetric,
  observeMetric,
  renderMetrics,
  setMetricGauge,
} from "./metrics.js";

assertProductionIntegrationsConfigured();

const app = express();
const PgSessionStore = connectPgSimple(session);
const sessionStore = new PgSessionStore({
  pool,
  tableName: "sessions",
  createTableIfMissing: true,
  pruneSessionInterval: 15 * 60,
});

app.disable("x-powered-by");
app.set("trust proxy", env.nodeEnv === "production" ? 1 : false);
app.use(requestIdMiddleware);
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => {
      const requestId = (req as typeof req & { requestId?: string }).requestId;
      return requestId ?? randomUUID();
    },
    customLogLevel: (_req, res, error) =>
      error || res.statusCode >= 500 ? "error" : "info",
    customSuccessMessage: (req, res) =>
      `${req.method} ${(req.url ?? "/").split("?")[0]} ${res.statusCode}`,
  }),
);
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.once("finish", () => {
    if (!req.path.startsWith("/api/")) return;
    incrementMetric("wcm_http_requests_total", {
      method: req.method,
      status: String(res.statusCode),
    });
    observeMetric(
      "wcm_http_request_duration_seconds",
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    );
  });
  next();
});

app.use(
  helmet({
    strictTransportSecurity: env.nodeEnv === "production" ? undefined : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

const webhookRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.post(
  "/api/billing/webhook",
  webhookRateLimit,
  express.raw({ type: "application/json", limit: "1mb" }),
  (req, res, next) => {
    void handleStripeWebhook(req, res).catch(next);
  },
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});
app.use("/api", apiLimiter);

app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(express.json({ limit: "64kb", strict: true }));
app.use(
  session({
    name: "wcm.sid",
    secret: env.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: env.nodeEnv === "production",
      sameSite: "lax",
      maxAge: env.sessionTtlMs,
      path: "/",
    },
  }),
);

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
app.get("/ready", async (_req, res) => {
  const readiness = await checkReadiness({
    postgres: pingDatabase,
    redis: () => redisControl.ping(),
  });
  res.status(readiness.status === "ready" ? 200 : 503).json(readiness);
});
app.get("/metrics", async (req, res) => {
  if (!env.metricsToken) {
    res.status(404).end();
    return;
  }
  const submitted = Buffer.from(req.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${env.metricsToken}`);
  if (
    submitted.length !== expected.length ||
    !timingSafeEqual(submitted, expected)
  ) {
    res
      .status(401)
      .setHeader("WWW-Authenticate", 'Bearer realm="metrics"')
      .end();
    return;
  }
  const [
    monitorWaiting,
    monitorActive,
    monitorDelayed,
    monitorFailed,
    notificationWaiting,
    notificationActive,
    notificationDelayed,
    notificationFailed,
    systemNotificationWaiting,
    systemNotificationActive,
    systemNotificationDelayed,
    systemNotificationFailed,
  ] = await Promise.all([
    monitorQueue.getWaitingCount(),
    monitorQueue.getActiveCount(),
    monitorQueue.getDelayedCount(),
    monitorQueue.getFailedCount(),
    notificationQueue.getWaitingCount(),
    notificationQueue.getActiveCount(),
    notificationQueue.getDelayedCount(),
    notificationQueue.getFailedCount(),
    systemNotificationQueue.getWaitingCount(),
    systemNotificationQueue.getActiveCount(),
    systemNotificationQueue.getDelayedCount(),
    systemNotificationQueue.getFailedCount(),
  ]);
  setMetricGauge("wcm_monitor_queue_waiting", monitorWaiting);
  setMetricGauge("wcm_monitor_queue_active", monitorActive);
  setMetricGauge("wcm_monitor_queue_delayed", monitorDelayed);
  setMetricGauge("wcm_monitor_queue_failed", monitorFailed);
  setMetricGauge("wcm_notification_queue_waiting", notificationWaiting);
  setMetricGauge("wcm_notification_queue_active", notificationActive);
  setMetricGauge("wcm_notification_queue_delayed", notificationDelayed);
  setMetricGauge("wcm_notification_queue_failed", notificationFailed);
  setMetricGauge(
    "wcm_system_notification_queue_waiting",
    systemNotificationWaiting,
  );
  setMetricGauge(
    "wcm_system_notification_queue_active",
    systemNotificationActive,
  );
  setMetricGauge(
    "wcm_system_notification_queue_delayed",
    systemNotificationDelayed,
  );
  setMetricGauge(
    "wcm_system_notification_queue_failed",
    systemNotificationFailed,
  );
  res.setHeader("Cache-Control", "no-store");
  res
    .type("text/plain; version=0.0.4; charset=utf-8")
    .send(await renderMetrics());
});
app.use("/api/auth", authRouter);
app.use("/api", monitorRouter);
app.use("/api", billingRouter);

app.use("/api", (_req, res) =>
  res.status(404).json({ error: "API route not found." }),
);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use(
  (
    error: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const statusCode =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 500;
    const requestId = req.requestId ?? "unknown";
    logger.error(
      {
        requestId,
        statusCode,
        errorCode:
          statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_REJECTED",
        err: error,
      },
      "Request failed",
    );
    res.status(statusCode).json({
      error:
        statusCode >= 500
          ? "An unexpected server error occurred."
          : "The request could not be processed.",
      requestId,
    });
  },
);

const server = app.listen(env.port, "0.0.0.0", () => {
  logger.info(
    { port: env.port, status: "listening" },
    "Website Change Monitor API started",
  );
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, "Shutting down API");
  server.close();
  await Promise.allSettled([closeQueues(), closeDatabase()]);
  process.exit(0);
}
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
