import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockSend };
  },
}));

let email: typeof import("./email.js");

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("EMAIL_FROM", "notifications@example.com");
  vi.stubEnv("APP_ORIGIN", "https://watchtower.example");
  vi.stubEnv("APP_BASE_URL", "https://watchtower.example");
  email = await import("./email.js");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ data: { id: "email-123" }, error: null });
});

describe("system notification email templates", () => {
  it("sends escaped persistent-failure details with a monitor deep link and idempotency key", async () => {
    await email.sendMonitorFailureEmail({
      to: "owner@example.com",
      monitorName: "Pricing <Pro>\r\nInjected",
      monitorId: "monitor-123",
      url: "https://public.example/pricing?a=1&b=2",
      consecutiveFailures: 3,
      lastErrorCode: "HTTP_STATUS_ERROR",
      occurredAt: "2026-10-05T09:00:00.000Z",
      dedupeKey: "failure:monitor-123:request-123",
    });

    const [message, options] = mockSend.mock.calls[0];
    expect(message.to).toBe("owner@example.com");
    expect(message.subject).toBe("Monitoring paused: Pricing <Pro> Injected");
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.text).toContain("after 3 consecutive failures");
    expect(message.text).toContain(
      "https://watchtower.example/?monitor=monitor-123",
    );
    expect(message.html).toContain("Pricing &lt;Pro&gt;");
    expect(message.html).toContain("a=1&amp;b=2");
    expect(options).toEqual({
      idempotencyKey: "system-failure:monitor-123:request-123",
    });
  });

  it("sends weekly change summaries and links each entry to its change record", async () => {
    await email.sendWeeklyDigestEmail({
      to: "owner@example.com",
      periodStart: "2026-09-28T09:00:00.000Z",
      periodEnd: "2026-10-05T09:00:00.000Z",
      dedupeKey: "weekly:2026-10-05T09:00:00.000Z:user-123",
      changes: [
        {
          changeId: "change-1",
          monitorName: "Pricing & plans",
          url: "https://public.example/pricing",
          detectedAt: "2026-10-02T12:00:00.000Z",
          addedCount: 2,
          removedCount: 1,
        },
      ],
    });

    const [message, options] = mockSend.mock.calls[0];
    expect(message.subject).toBe("Your Watchtower weekly change digest (1)");
    expect(message.text).toContain("2 additions · 1 removals");
    expect(message.html).toContain("Pricing &amp; plans");
    expect(message.html).toContain(
      "https://watchtower.example/?change=change-1",
    );
    expect(options).toEqual({
      idempotencyKey: "system-weekly:2026-10-05T09:00:00.000Z:user-123",
    });
  });
});
