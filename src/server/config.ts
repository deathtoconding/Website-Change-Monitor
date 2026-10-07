import "dotenv/config";
import { z } from "zod";
import {
  assertProductionInfrastructureConfigured,
  assertProductionUrls,
  getMissingProductionEmailConfiguration,
} from "./config-validation.js";

const secretDefault = "local-development-only-change-this-session-secret";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://wcm:wcm@127.0.0.1:5432/wcm"),
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
  SESSION_SECRET: z.string().min(32).default(secretDefault),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  APP_BASE_URL: z.string().url().optional(),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  SCHEDULER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(10_000),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().default("alerts@example.com"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_STARTER: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
  MAX_FETCH_BYTES: z.coerce
    .number()
    .int()
    .min(64_000)
    .max(10_000_000)
    .default(2_000_000),
  FETCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(15_000),
  FETCH_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),
  FETCH_DOMAIN_COOLDOWN_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(60_000)
    .default(1_000),
  ALLOW_DEV_VERIFICATION_TOKEN: z.enum(["true", "false"]).default("true"),
  METRICS_TOKEN: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().min(24).optional(),
  ),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "Invalid environment configuration:",
    parsed.error.flatten().fieldErrors,
  );
  throw new Error("Environment configuration is invalid.");
}

const appOriginUrl = new URL(parsed.data.APP_ORIGIN);
const appBaseUrl = new URL(parsed.data.APP_BASE_URL ?? parsed.data.APP_ORIGIN);
if (
  appOriginUrl.pathname !== "/" ||
  appOriginUrl.search ||
  appOriginUrl.hash ||
  appOriginUrl.username ||
  appOriginUrl.password
) {
  throw new Error(
    "APP_ORIGIN must be an origin without a path, query, or credentials.",
  );
}
if (
  appBaseUrl.pathname !== "/" ||
  appBaseUrl.search ||
  appBaseUrl.hash ||
  appBaseUrl.username ||
  appBaseUrl.password
) {
  throw new Error(
    "APP_BASE_URL must be an origin without a path, query, or credentials.",
  );
}

assertProductionUrls(parsed.data.NODE_ENV, appOriginUrl, appBaseUrl);
assertProductionInfrastructureConfigured(
  parsed.data.NODE_ENV,
  process.env.DATABASE_URL,
  process.env.REDIS_URL,
);

if (parsed.data.NODE_ENV === "production") {
  if (
    parsed.data.SESSION_SECRET === secretDefault ||
    /replace-with|change-me|example/i.test(parsed.data.SESSION_SECRET)
  ) {
    throw new Error(
      "SESSION_SECRET must be a unique, randomly generated secret in production.",
    );
  }
  if (!process.env.APP_ORIGIN)
    throw new Error("APP_ORIGIN must be explicitly configured in production.");
  if (parsed.data.ALLOW_DEV_VERIFICATION_TOKEN === "true")
    throw new Error(
      "ALLOW_DEV_VERIFICATION_TOKEN must be false in production.",
    );
}

export const env = {
  nodeEnv: parsed.data.NODE_ENV,
  port: parsed.data.PORT,
  databaseUrl: parsed.data.DATABASE_URL,
  redisUrl: parsed.data.REDIS_URL,
  sessionSecret: parsed.data.SESSION_SECRET,
  appOrigin: parsed.data.APP_ORIGIN.replace(/\/$/, ""),
  appBaseUrl: (parsed.data.APP_BASE_URL ?? parsed.data.APP_ORIGIN).replace(
    /\/$/,
    "",
  ),
  sessionTtlMs: parsed.data.SESSION_TTL_HOURS * 60 * 60 * 1_000,
  workerConcurrency: parsed.data.WORKER_CONCURRENCY,
  schedulerIntervalMs: parsed.data.SCHEDULER_INTERVAL_MS,
  resendApiKey: parsed.data.RESEND_API_KEY,
  emailFrom: parsed.data.EMAIL_FROM,
  stripeSecretKey: parsed.data.STRIPE_SECRET_KEY,
  stripeWebhookSecret: parsed.data.STRIPE_WEBHOOK_SECRET,
  stripePriceStarter: parsed.data.STRIPE_PRICE_STARTER,
  stripePriceBusiness: parsed.data.STRIPE_PRICE_BUSINESS,
  maxFetchBytes: parsed.data.MAX_FETCH_BYTES,
  fetchTimeoutMs: parsed.data.FETCH_TIMEOUT_MS,
  fetchMaxRedirects: parsed.data.FETCH_MAX_REDIRECTS,
  fetchDomainCooldownMs: parsed.data.FETCH_DOMAIN_COOLDOWN_MS,
  allowDevVerificationToken:
    parsed.data.ALLOW_DEV_VERIFICATION_TOKEN === "true" &&
    parsed.data.NODE_ENV !== "production",
  metricsToken: parsed.data.METRICS_TOKEN,
} as const;

export function assertEmailIntegrationConfigured() {
  const missing = getMissingProductionEmailConfiguration(
    env.nodeEnv,
    env.resendApiKey,
    env.emailFrom,
  );
  if (missing.length)
    throw new Error(
      `Missing production integration configuration: ${missing.join(", ")}`,
    );
}

export function assertProductionIntegrationsConfigured() {
  if (env.nodeEnv !== "production") return;
  assertEmailIntegrationConfigured();
  const missing: string[] = [];
  if (!env.stripeSecretKey) missing.push("STRIPE_SECRET_KEY");
  if (!env.stripeWebhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!env.stripePriceStarter) missing.push("STRIPE_PRICE_STARTER");
  if (!env.stripePriceBusiness) missing.push("STRIPE_PRICE_BUSINESS");
  if (missing.length)
    throw new Error(
      `Missing production integration configuration: ${missing.join(", ")}`,
    );
}
