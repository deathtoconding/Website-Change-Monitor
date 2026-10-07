import { describe, expect, it } from "vitest";
import {
  diffText,
  formatRelativeTime,
  FREQUENCY_LABELS,
  nextCheckDate,
  normalizeContent,
  validateMonitorUrl,
} from "./monitoring";

describe("validateMonitorUrl", () => {
  it("accepts public HTTP and HTTPS pages and normalizes surrounding whitespace", () => {
    expect(validateMonitorUrl("  https://example.com/pricing  ")).toBeNull();
    expect(validateMonitorUrl("http://93.184.216.34")).toBeNull();
    expect(validateMonitorUrl("https://www.example.com")).toBeNull();
  });

  it("rejects non-web protocols, malformed URLs, and embedded credentials", () => {
    expect(validateMonitorUrl("file:///etc/passwd")).toBe(
      "Only HTTP and HTTPS URLs can be monitored.",
    );
    expect(validateMonitorUrl("not a url")).toBe(
      "Enter a complete URL, such as https://example.com/pricing.",
    );
    expect(validateMonitorUrl("https://user:secret@example.com")).toBe(
      "URLs containing a username or password are not supported.",
    );
  });

  it("blocks common local hostnames and private or reserved IP literals", () => {
    for (const url of [
      "http://localhost",
      "https://admin.localhost/path",
      "http://printer.local",
      "http://service.internal",
      "http://127.0.0.1",
      "http://10.2.3.4",
      "http://172.20.1.8",
      "http://192.168.1.1",
      "http://169.254.169.254",
      "http://[::1]",
      "http://[fd00::12]",
    ]) {
      expect(validateMonitorUrl(url), url).not.toBeNull();
    }
  });

  it("documents the client preflight limitation in its error-free API", () => {
    expect(validateMonitorUrl("https://public.example.org")).toBeNull();
  });
});

describe("normalizeContent", () => {
  it("normalizes line endings and whitespace deterministically while dropping blank lines", () => {
    expect(normalizeContent("  Pro  \r\n\r\n$49\t per month\n  \n")).toBe(
      "Pro\n$49 per month",
    );
  });

  it("preserves the meaningful line order", () => {
    expect(normalizeContent("First\nSecond\nThird")).toBe(
      "First\nSecond\nThird",
    );
  });
});

describe("diffText", () => {
  it("marks additions, removals, and unchanged lines in stable order", () => {
    expect(
      diffText(
        "Plan\n$49\nUnlimited projects",
        "Plan\n$59\nUnlimited projects\nPriority support",
      ),
    ).toEqual([
      { kind: "unchanged", text: "Plan" },
      { kind: "removed", text: "$49" },
      { kind: "added", text: "$59" },
      { kind: "unchanged", text: "Unlimited projects" },
      { kind: "added", text: "Priority support" },
    ]);
  });

  it("returns only unchanged lines when content is the same", () => {
    expect(diffText("A\nB", " A \nB\n")).toEqual([
      { kind: "unchanged", text: "A" },
      { kind: "unchanged", text: "B" },
    ]);
  });

  it("bounds large diff work and retains common prefix and suffix", () => {
    const before = [
      "Header",
      ...Array.from({ length: 301 }, (_, index) => `old section ${index}`),
      "Footer",
    ];
    const after = [
      "Header",
      ...Array.from({ length: 301 }, (_, index) => `new section ${index}`),
      "Footer",
    ];
    const result = diffText(before.join("\n"), after.join("\n"));
    expect(result[0]).toEqual({ kind: "unchanged", text: "Header" });
    expect(result[1]).toEqual({ kind: "removed", text: "old section 0" });
    expect(result[result.length - 1]).toEqual({
      kind: "unchanged",
      text: "Footer",
    });
    expect(result.filter((line) => line.kind === "added")).toHaveLength(301);
  });
});

describe("frequency and display helpers", () => {
  it("calculates each schedule interval from the supplied time", () => {
    const start = new Date("2026-10-07T12:00:00.000Z");
    expect(nextCheckDate(start, "hourly").toISOString()).toBe(
      "2026-10-07T13:00:00.000Z",
    );
    expect(nextCheckDate(start, "six-hourly").toISOString()).toBe(
      "2026-10-07T18:00:00.000Z",
    );
    expect(nextCheckDate(start, "daily").toISOString()).toBe(
      "2026-10-08T12:00:00.000Z",
    );
    expect(FREQUENCY_LABELS["six-hourly"]).toBe("Every 6 hours");
  });

  it("formats relative times against a fixed clock", () => {
    const now = new Date("2026-10-07T12:00:00.000Z").getTime();
    expect(formatRelativeTime("2026-10-07T11:30:00.000Z", now)).toBe("30m ago");
    expect(formatRelativeTime("2026-10-07T14:00:00.000Z", now)).toBe("in 2h");
    expect(formatRelativeTime(null, now)).toBe("Not checked yet");
  });
});
