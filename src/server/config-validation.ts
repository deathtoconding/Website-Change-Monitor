import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export function getConfiguredTestFixtureOrigin(
  nodeEnv: string,
  fixtureOrigin: string | undefined,
  fixtureAddress: string | undefined,
): string | undefined {
  const fixtureUrl = fixtureOrigin ? new URL(fixtureOrigin) : undefined;
  if (fixtureUrl && nodeEnv !== "test")
    throw new Error("TEST_FIXTURE_ORIGIN is only allowed in NODE_ENV=test.");
  if (
    fixtureUrl &&
    (fixtureUrl.protocol !== "http:" ||
      fixtureUrl.pathname !== "/" ||
      fixtureUrl.search ||
      fixtureUrl.hash ||
      fixtureUrl.username ||
      fixtureUrl.password)
  ) {
    throw new Error(
      "TEST_FIXTURE_ORIGIN must be an HTTP origin without a path or credentials.",
    );
  }
  if (
    fixtureAddress &&
    (nodeEnv !== "test" || !fixtureUrl || !isIP(fixtureAddress))
  ) {
    throw new Error(
      "TEST_FIXTURE_ADDRESS requires a test fixture origin and a valid IP in NODE_ENV=test.",
    );
  }
  return fixtureUrl?.origin;
}

export function assertProductionUrls(
  nodeEnv: string,
  appOriginUrl: URL,
  appBaseUrl: URL,
): void {
  if (nodeEnv !== "production") return;
  if (appOriginUrl.protocol !== "https:")
    throw new Error("APP_ORIGIN must use HTTPS in production.");
  if (appBaseUrl.protocol !== "https:")
    throw new Error("APP_BASE_URL must use HTTPS in production.");
}

export function assertProductionDatabaseUrlConfigured(
  nodeEnv: string,
  databaseUrl: string | undefined,
): void {
  if (nodeEnv !== "production") return;
  if (!databaseUrl?.trim())
    throw new Error(
      "Missing production infrastructure configuration: DATABASE_URL",
    );
  assertProductionConnectionUrl("DATABASE_URL", databaseUrl, [
    "postgres:",
    "postgresql:",
  ]);
}

export function assertProductionInfrastructureConfigured(
  nodeEnv: string,
  databaseUrl: string | undefined,
  redisUrl: string | undefined,
): void {
  if (nodeEnv !== "production") return;
  const missing: string[] = [];
  if (!databaseUrl?.trim()) missing.push("DATABASE_URL");
  if (!redisUrl?.trim()) missing.push("REDIS_URL");
  if (missing.length)
    throw new Error(
      `Missing production infrastructure configuration: ${missing.join(", ")}`,
    );

  assertProductionDatabaseUrlConfigured(nodeEnv, databaseUrl);
  assertProductionConnectionUrl("REDIS_URL", redisUrl!, ["redis:", "rediss:"]);
}

function assertProductionConnectionUrl(
  name: string,
  value: string,
  allowedProtocols: readonly string[],
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid production connection URL.`);
  }

  if (!allowedProtocols.includes(url.protocol) || !url.hostname) {
    throw new Error(`${name} must use a supported network connection URL.`);
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const localHostname =
    hostname === "localhost" || hostname === "localhost.localdomain";
  let loopbackAddress = false;
  try {
    const address = ipaddr.process(hostname);
    loopbackAddress =
      address.range() === "loopback" || address.range() === "unspecified";
  } catch {
    // Hostnames are valid connection targets too; only parsed local IPs are rejected here.
  }

  if (localHostname || loopbackAddress) {
    throw new Error(
      `${name} must not point to a loopback or unspecified local endpoint in production.`,
    );
  }
}

export function getMissingProductionEmailConfiguration(
  nodeEnv: string,
  resendApiKey: string | undefined,
  emailFrom: string,
): string[] {
  if (nodeEnv !== "production") return [];
  const missing: string[] = [];
  if (!resendApiKey) missing.push("RESEND_API_KEY");
  const senderDomain = emailFrom
    .slice(emailFrom.lastIndexOf("@") + 1)
    .toLowerCase();
  const placeholderSenderDomain =
    /(^|\.)example\.(com|net|org)$/.test(senderDomain) ||
    [".test", ".invalid", ".example", ".localhost"].some((suffix) =>
      senderDomain.endsWith(suffix),
    );
  if (placeholderSenderDomain)
    missing.push("EMAIL_FROM (use a verified sender domain)");
  return missing;
}
