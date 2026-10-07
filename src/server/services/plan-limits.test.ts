import { describe, expect, it } from "vitest";
import { resolveEffectivePlan, type Plan } from "./plan-limits.js";

describe("resolveEffectivePlan", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");

  it("uses the newest active paid subscription", () => {
    expect(
      resolveEffectivePlan(
        [
          { plan: "business", status: "active", periodEnd: null },
          { plan: "free", status: "active", periodEnd: null },
        ],
        now,
      ),
    ).toBe("business");
  });

  it("keeps a canceled plan through its paid period and then falls back to free", () => {
    expect(
      resolveEffectivePlan(
        [
          {
            plan: "starter",
            status: "canceled",
            periodEnd: new Date("2026-10-08T00:00:00Z"),
          },
        ],
        now,
      ),
    ).toBe("starter");
    expect(
      resolveEffectivePlan(
        [
          {
            plan: "starter",
            status: "canceled",
            periodEnd: new Date("2026-10-06T00:00:00Z"),
          },
        ],
        now,
      ),
    ).toBe("free");
  });

  it("retains access for a past-due subscription until its period ends", () => {
    expect(
      resolveEffectivePlan(
        [
          {
            plan: "business",
            status: "past_due",
            periodEnd: new Date("2026-10-08T00:00:00Z"),
          },
        ],
        now,
      ),
    ).toBe("business");
    expect(
      resolveEffectivePlan(
        [
          {
            plan: "business",
            status: "past_due",
            periodEnd: new Date("2026-10-06T00:00:00Z"),
          },
        ],
        now,
      ),
    ).toBe("free");
  });

  it("considers older effective subscriptions beyond a long history of inactive rows", () => {
    const inactiveHistory: {
      plan: Plan;
      status: string;
      periodEnd: Date | null;
    }[] = Array.from({ length: 12 }, () => ({
      plan: "free",
      status: "unpaid",
      periodEnd: null,
    }));
    inactiveHistory.push({
      plan: "business",
      status: "active",
      periodEnd: null,
    });
    expect(resolveEffectivePlan(inactiveHistory, now)).toBe("business");
  });

  it("ignores incomplete or unpaid subscriptions but can fall back to an older active plan", () => {
    expect(
      resolveEffectivePlan(
        [
          { plan: "starter", status: "incomplete", periodEnd: null },
          { plan: "free", status: "active", periodEnd: null },
        ],
        now,
      ),
    ).toBe("free");
    expect(
      resolveEffectivePlan(
        [{ plan: "business", status: "unpaid", periodEnd: null }],
        now,
      ),
    ).toBe("free");
  });
});
