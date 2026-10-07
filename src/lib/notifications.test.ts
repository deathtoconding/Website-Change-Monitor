import { describe, expect, it } from "vitest";
import {
  countDiffChanges,
  failureNotificationDedupeKey,
  getWeeklyDigestPeriod,
  PERSISTENT_FAILURE_THRESHOLD,
  shouldNotifyForPersistentFailure,
  weeklyDigestDedupeKey,
} from "./notifications.js";

describe("weekly digest scheduling", () => {
  it("waits until Monday at 09:00 UTC before producing the week's digest", () => {
    expect(getWeeklyDigestPeriod(new Date("2026-10-05T08:59:59.999Z"))).toBe(
      null,
    );
    expect(getWeeklyDigestPeriod(new Date("2026-10-05T09:00:00.000Z"))).toEqual(
      {
        start: new Date("2026-09-28T09:00:00.000Z"),
        end: new Date("2026-10-05T09:00:00.000Z"),
      },
    );
  });

  it("uses the same UTC week window on later days and across year boundaries", () => {
    expect(getWeeklyDigestPeriod(new Date("2026-10-11T18:30:00.000Z"))).toEqual(
      {
        start: new Date("2026-09-28T09:00:00.000Z"),
        end: new Date("2026-10-05T09:00:00.000Z"),
      },
    );
    expect(getWeeklyDigestPeriod(new Date("2027-01-04T09:00:00.000Z"))).toEqual(
      {
        start: new Date("2026-12-28T09:00:00.000Z"),
        end: new Date("2027-01-04T09:00:00.000Z"),
      },
    );
  });

  it("creates stable per-user idempotency keys and counts only additions and removals", () => {
    const periodEnd = new Date("2026-10-05T09:00:00.000Z");
    expect(weeklyDigestDedupeKey("user-123", periodEnd)).toBe(
      "weekly:2026-10-05T09:00:00.000Z:user-123",
    );
    expect(failureNotificationDedupeKey("monitor-1", "request-2")).toBe(
      "failure:monitor-1:request-2",
    );
    expect(PERSISTENT_FAILURE_THRESHOLD).toBe(3);
    expect(shouldNotifyForPersistentFailure(2, true)).toBe(false);
    expect(shouldNotifyForPersistentFailure(3, true)).toBe(true);
    expect(shouldNotifyForPersistentFailure(4, false)).toBe(false);
    expect(
      countDiffChanges([
        { kind: "added", text: "Added" },
        { kind: "removed", text: "Removed" },
        { kind: "unchanged", text: "Same" },
      ]),
    ).toEqual({ addedCount: 1, removedCount: 1 });
  });
});
