import { beforeAll, describe, expect, it, vi } from "vitest";

const { mockRedis } = vi.hoisted(() => {
  const hashes = new Map<string, Map<string, string>>();
  return {
    mockRedis: {
      reset() {
        hashes.clear();
      },
      hincrby: vi.fn(async (hash: string, field: string, increment: number) => {
        const values = hashes.get(hash) ?? new Map<string, string>();
        const next = Number(values.get(field) ?? 0) + increment;
        values.set(field, String(next));
        hashes.set(hash, values);
        return next;
      }),
      hincrbyfloat: vi.fn(
        async (hash: string, field: string, increment: string) => {
          const values = hashes.get(hash) ?? new Map<string, string>();
          const next = Number(values.get(field) ?? 0) + Number(increment);
          values.set(field, String(next));
          hashes.set(hash, values);
          return String(next);
        },
      ),
      hgetall: vi.fn(async (hash: string) =>
        Object.fromEntries(hashes.get(hash) ?? []),
      ),
    },
  };
});

vi.mock("./queue.js", () => ({ redis: mockRedis }));

let metrics: typeof import("./metrics.js");
beforeAll(async () => {
  metrics = await import("./metrics.js");
});

describe("Prometheus notification and queue metrics", () => {
  it("exposes system-email outcomes and delayed/failed queue depth", async () => {
    mockRedis.reset();
    metrics.incrementMetric("wcm_system_notifications_total", {
      kind: "weekly_digest",
      result: "sent",
    });
    metrics.incrementMetric("wcm_system_notifications_total", {
      kind: "weekly_digest",
      result: "sent",
    });
    metrics.setMetricGauge("wcm_monitor_queue_delayed", 3);
    metrics.setMetricGauge("wcm_notification_queue_failed", 1);
    metrics.setMetricGauge("wcm_system_notification_queue_waiting", 4);

    const rendered = await metrics.renderMetrics();

    expect(rendered).toContain(
      "# HELP wcm_system_notifications_total Failure and weekly-digest email delivery outcomes.",
    );
    expect(rendered).toContain(
      'wcm_system_notifications_total{kind="weekly_digest",result="sent"} 2',
    );
    expect(rendered).toContain("wcm_monitor_queue_delayed 3");
    expect(rendered).toContain("wcm_notification_queue_failed 1");
    expect(rendered).toContain("wcm_system_notification_queue_waiting 4");
  });
});
