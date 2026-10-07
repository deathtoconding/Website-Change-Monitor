import { describe, expect, it } from "vitest";
import {
  assertProductionDatabaseUrlConfigured,
  assertProductionInfrastructureConfigured,
  assertProductionUrls,
  getMissingProductionEmailConfiguration,
} from "./config-validation.js";

describe("production configuration validation", () => {
  it("requires HTTPS for both the app origin and email-link base URL", () => {
    expect(() =>
      assertProductionUrls(
        "production",
        new URL("https://app.example.test"),
        new URL("http://links.example.test"),
      ),
    ).toThrow("APP_BASE_URL must use HTTPS in production.");

    expect(() =>
      assertProductionUrls(
        "production",
        new URL("http://app.example.test"),
        new URL("https://links.example.test"),
      ),
    ).toThrow("APP_ORIGIN must use HTTPS in production.");
  });

  it("allows separate HTTPS origins and leaves local HTTP development usable", () => {
    expect(() =>
      assertProductionUrls(
        "production",
        new URL("https://app.example.test"),
        new URL("https://links.example.test"),
      ),
    ).not.toThrow();
    expect(() =>
      assertProductionUrls(
        "development",
        new URL("http://localhost:3000"),
        new URL("http://localhost:3001"),
      ),
    ).not.toThrow();
  });

  it("keeps the production migration tool from falling back to a local database", () => {
    expect(() =>
      assertProductionDatabaseUrlConfigured("production", undefined),
    ).toThrow("DATABASE_URL");
    expect(() =>
      assertProductionDatabaseUrlConfigured(
        "production",
        "postgres://wcm:wcm@127.0.0.1:5432/wcm",
      ),
    ).toThrow("local endpoint");
    expect(() =>
      assertProductionDatabaseUrlConfigured("development", undefined),
    ).not.toThrow();
  });

  it("requires explicit, non-local database and Redis URLs in production", () => {
    expect(() =>
      assertProductionInfrastructureConfigured(
        "production",
        undefined,
        undefined,
      ),
    ).toThrow("DATABASE_URL, REDIS_URL");
    expect(() =>
      assertProductionInfrastructureConfigured(
        "production",
        "postgres://db.example.test/wcm",
        "rediss://cache.example.test:6380",
      ),
    ).not.toThrow();
    expect(() =>
      assertProductionInfrastructureConfigured(
        "production",
        "postgres://wcm:wcm@127.0.0.1:5432/wcm",
        "redis://cache.example.test:6379",
      ),
    ).toThrow(
      "DATABASE_URL must not point to a loopback or unspecified local endpoint",
    );
    for (const localDatabaseUrl of [
      "postgres://wcm@[::1]:5432/wcm",
      "postgres://wcm@[::ffff:127.0.0.1]:5432/wcm",
      "postgres://wcm@127.1:5432/wcm",
    ]) {
      expect(() =>
        assertProductionInfrastructureConfigured(
          "production",
          localDatabaseUrl,
          "rediss://cache.example.test:6380",
        ),
      ).toThrow(
        "DATABASE_URL must not point to a loopback or unspecified local endpoint",
      );
    }
    expect(() =>
      assertProductionInfrastructureConfigured(
        "production",
        "postgres://db.example.test/wcm",
        "redis://localhost:6379",
      ),
    ).toThrow(
      "REDIS_URL must not point to a loopback or unspecified local endpoint",
    );
    expect(() =>
      assertProductionInfrastructureConfigured(
        "production",
        "https://db.example.test/wcm",
        "redis://cache.example.test:6379",
      ),
    ).toThrow("DATABASE_URL must use a supported network connection URL");
    expect(() =>
      assertProductionInfrastructureConfigured(
        "development",
        undefined,
        undefined,
      ),
    ).not.toThrow();
  });

  it("requires a configured email provider and non-example sender in production", () => {
    expect(
      getMissingProductionEmailConfiguration(
        "production",
        undefined,
        "alerts@example.com",
      ),
    ).toEqual(["RESEND_API_KEY", "EMAIL_FROM (use a verified sender domain)"]);
    expect(
      getMissingProductionEmailConfiguration(
        "production",
        "re_test_key",
        "alerts@watchtower.io",
      ),
    ).toEqual([]);
    expect(
      getMissingProductionEmailConfiguration(
        "production",
        "re_test_key",
        "alerts@EXAMPLE.COM",
      ),
    ).toEqual(["EMAIL_FROM (use a verified sender domain)"]);
    expect(
      getMissingProductionEmailConfiguration(
        "development",
        undefined,
        "alerts@example.com",
      ),
    ).toEqual([]);
  });
});
