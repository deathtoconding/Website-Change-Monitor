import { describe, expect, it, vi } from "vitest";
import { checkReadiness } from "./readiness.js";

describe("dependency readiness", () => {
  it("returns ready when PostgreSQL and Redis respond", async () => {
    await expect(
      checkReadiness({
        postgres: vi.fn().mockResolvedValue(undefined),
        redis: vi.fn().mockResolvedValue("PONG"),
      }),
    ).resolves.toEqual({
      status: "ready",
      dependencies: { postgres: "ok", redis: "ok" },
    });
  });

  it("reports PostgreSQL failure without hiding Redis health", async () => {
    await expect(
      checkReadiness({
        postgres: vi.fn().mockRejectedValue(new Error("database down")),
        redis: vi.fn().mockResolvedValue("PONG"),
      }),
    ).resolves.toEqual({
      status: "not_ready",
      dependencies: { postgres: "unavailable", redis: "ok" },
    });
  });

  it("reports Redis failure without hiding PostgreSQL health", async () => {
    await expect(
      checkReadiness({
        postgres: vi.fn().mockResolvedValue(undefined),
        redis: vi.fn().mockRejectedValue(new Error("redis down")),
      }),
    ).resolves.toEqual({
      status: "not_ready",
      dependencies: { postgres: "ok", redis: "unavailable" },
    });
  });

  it("reports both dependencies independently when both fail", async () => {
    await expect(
      checkReadiness({
        postgres: vi.fn().mockRejectedValue(new Error("database down")),
        redis: vi.fn().mockRejectedValue(new Error("redis down")),
      }),
    ).resolves.toEqual({
      status: "not_ready",
      dependencies: { postgres: "unavailable", redis: "unavailable" },
    });
  });

  it("bounds a stalled Redis probe and returns the PostgreSQL result", async () => {
    const startedAt = performance.now();
    const result = await checkReadiness(
      {
        postgres: vi.fn().mockResolvedValue(undefined),
        redis: () => new Promise(() => undefined),
      },
      15,
    );

    expect(result).toEqual({
      status: "not_ready",
      dependencies: { postgres: "ok", redis: "unavailable" },
    });
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("starts dependency probes concurrently", async () => {
    let releasePostgres!: () => void;
    let releaseRedis!: () => void;
    const postgres = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePostgres = resolve;
        }),
    );
    const redis = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRedis = resolve;
        }),
    );

    const pending = checkReadiness({ postgres, redis });
    await vi.waitFor(() => {
      expect(postgres).toHaveBeenCalledOnce();
      expect(redis).toHaveBeenCalledOnce();
    });
    releasePostgres();
    releaseRedis();

    await expect(pending).resolves.toMatchObject({ status: "ready" });
  });
});
