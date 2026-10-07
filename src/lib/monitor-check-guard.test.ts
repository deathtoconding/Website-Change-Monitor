import { describe, expect, it } from "vitest";
import { canCommitMonitorFetch } from "./monitor-check-guard.js";

describe("monitor fetch commit guard", () => {
  const candidate = {
    url: "https://example.com/pricing",
    selector: "main .price",
  };

  it("accepts results only while the active target still matches", () => {
    expect(
      canCommitMonitorFetch(candidate, { ...candidate, status: "active" }),
    ).toBe(true);
  });

  it("discards results fetched before the URL or selector changed", () => {
    expect(
      canCommitMonitorFetch(candidate, {
        ...candidate,
        url: "https://example.com/new-pricing",
        status: "active",
      }),
    ).toBe(false);
    expect(
      canCommitMonitorFetch(candidate, {
        ...candidate,
        selector: "main .new-price",
        status: "active",
      }),
    ).toBe(false);
  });

  it("discards results for monitors no longer active", () => {
    for (const status of ["paused", "deleted", "error"]) {
      expect(canCommitMonitorFetch(candidate, { ...candidate, status })).toBe(
        false,
      );
    }
  });
});
