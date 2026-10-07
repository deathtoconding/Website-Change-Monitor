import { describe, expect, it } from "vitest";
import { shouldRequeueStaleFailedMonitorJob } from "./queue-recovery.js";

describe("stale monitor job recovery", () => {
  const now = 1_800_000_000_000;
  const retryAfterMs = 120_000;

  it("does not replace active, delayed, or recently failed jobs", () => {
    expect(
      shouldRequeueStaleFailedMonitorJob(
        "active",
        now - retryAfterMs,
        now,
        retryAfterMs,
      ),
    ).toBe(false);
    expect(
      shouldRequeueStaleFailedMonitorJob(
        "delayed",
        now - retryAfterMs,
        now,
        retryAfterMs,
      ),
    ).toBe(false);
    expect(
      shouldRequeueStaleFailedMonitorJob(
        "failed",
        now - retryAfterMs + 1,
        now,
        retryAfterMs,
      ),
    ).toBe(false);
  });

  it("recovers a terminal failed job only after the failure-recording grace period", () => {
    expect(
      shouldRequeueStaleFailedMonitorJob(
        "failed",
        now - retryAfterMs,
        now,
        retryAfterMs,
      ),
    ).toBe(true);
  });

  it("does not recover jobs without a valid completion timestamp", () => {
    expect(
      shouldRequeueStaleFailedMonitorJob(
        "failed",
        undefined,
        now,
        retryAfterMs,
      ),
    ).toBe(false);
    expect(
      shouldRequeueStaleFailedMonitorJob(
        "failed",
        Number.NaN,
        now,
        retryAfterMs,
      ),
    ).toBe(false);
    expect(
      shouldRequeueStaleFailedMonitorJob("failed", now + 1, now, retryAfterMs),
    ).toBe(false);
    expect(shouldRequeueStaleFailedMonitorJob("failed", now - 1, now, -1)).toBe(
      false,
    );
  });
});
