import { redis } from "./queue.js";

const counters = new Map<
  string,
  { name: string; labels: Record<string, string>; value: number }
>();
const histograms = new Map<string, { count: number; sum: number }>();
const COUNTER_HASH = "wcm:metrics:counters:v1";
const HISTOGRAM_HASH = "wcm:metrics:histograms:v1";
const COUNTER_HELP = {
  wcm_monitor_checks_total: "Completed monitor checks grouped by result.",
  wcm_monitor_check_failures_total:
    "Monitor checks that failed and will not create snapshots.",
  wcm_changes_detected_total: "Meaningful page-content changes detected.",
  wcm_change_notifications_total: "Change notification delivery outcomes.",
  wcm_system_notifications_total:
    "Failure and weekly-digest email delivery outcomes.",
  wcm_http_requests_total:
    "API requests grouped by method and response status.",
} satisfies Record<string, string>;
const HISTOGRAM_HELP = {
  wcm_monitor_check_duration_seconds:
    "Monitor check processing duration in seconds.",
  wcm_http_request_duration_seconds: "API request duration in seconds.",
} satisfies Record<string, string>;
const GAUGE_HELP = {
  wcm_monitor_queue_waiting: "Monitor jobs waiting to be processed.",
  wcm_monitor_queue_active: "Monitor jobs currently being processed.",
  wcm_monitor_queue_delayed: "Monitor jobs delayed for retry or scheduling.",
  wcm_monitor_queue_failed: "Monitor jobs in the failed BullMQ state.",
  wcm_notification_queue_waiting:
    "Change-email notification jobs waiting to be processed.",
  wcm_notification_queue_active:
    "Change-email notification jobs currently being processed.",
  wcm_notification_queue_delayed:
    "Change-email notification jobs delayed for retry.",
  wcm_notification_queue_failed:
    "Change-email notification jobs in the failed BullMQ state.",
  wcm_system_notification_queue_waiting:
    "System-email notification jobs waiting to be processed.",
  wcm_system_notification_queue_active:
    "System-email notification jobs currently being processed.",
  wcm_system_notification_queue_delayed:
    "System-email notification jobs delayed for retry.",
  wcm_system_notification_queue_failed:
    "System-email notification jobs in the failed BullMQ state.",
} satisfies Record<string, string>;
const gauges = new Map<keyof typeof GAUGE_HELP, number>();

type CounterSeries = {
  name: string;
  labels: Record<string, string>;
  value: number;
};

export function incrementMetric(
  name: keyof typeof COUNTER_HELP,
  labels: Record<string, string> = {},
): void {
  const normalizedLabels = Object.fromEntries(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  );
  const key = JSON.stringify([name, normalizedLabels]);
  const item = counters.get(key) ?? {
    name,
    labels: normalizedLabels,
    value: 0,
  };
  item.value += 1;
  counters.set(key, item);
  void redis.hincrby(COUNTER_HASH, key, 1).catch(() => undefined);
}

export function observeMetric(
  name: keyof typeof HISTOGRAM_HELP,
  value: number,
): void {
  if (!Number.isFinite(value) || value < 0) return;
  const item = histograms.get(name) ?? { count: 0, sum: 0 };
  item.count += 1;
  item.sum += value;
  histograms.set(name, item);
  void Promise.all([
    redis.hincrby(HISTOGRAM_HASH, `${name}:count`, 1),
    redis.hincrbyfloat(HISTOGRAM_HASH, `${name}:sum`, String(value)),
  ]).catch(() => undefined);
}

export function setMetricGauge(
  name: keyof typeof GAUGE_HELP,
  value: number,
): void {
  if (Number.isFinite(value)) gauges.set(name, value);
}

export async function renderMetrics(): Promise<string> {
  let counterSeries: CounterSeries[] = [...counters.values()];
  let histogramValues = new Map(histograms);
  try {
    const [storedCounters, storedHistograms] = await Promise.all([
      redis.hgetall(COUNTER_HASH),
      redis.hgetall(HISTOGRAM_HASH),
    ]);
    counterSeries = Object.entries(storedCounters).flatMap(
      ([key, rawValue]) => {
        try {
          const [name, labels] = JSON.parse(key) as [
            keyof typeof COUNTER_HELP,
            Record<string, string>,
          ];
          const value = Number(rawValue);
          return name in COUNTER_HELP && Number.isFinite(value)
            ? [{ name, labels, value }]
            : [];
        } catch {
          return [];
        }
      },
    );
    histogramValues = new Map(
      Object.keys(HISTOGRAM_HELP).map((name) => [
        name,
        {
          count: Number(storedHistograms[`${name}:count`] ?? 0),
          sum: Number(storedHistograms[`${name}:sum`] ?? 0),
        },
      ]),
    );
  } catch {
    // Keep the endpoint useful with process-local values while Redis is unavailable.
  }

  const output: string[] = [];
  for (const [name, help] of Object.entries(COUNTER_HELP)) {
    output.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const item of counterSeries) {
      if (item.name !== name) continue;
      const labels = Object.entries(item.labels)
        .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
        .join(",");
      output.push(`${name}${labels ? `{${labels}}` : ""} ${item.value}`);
    }
  }
  for (const [name, help] of Object.entries(HISTOGRAM_HELP)) {
    output.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
    const item = histogramValues.get(name) ?? { count: 0, sum: 0 };
    output.push(`${name}_sum ${item.sum}`, `${name}_count ${item.count}`);
  }
  for (const [name, value] of gauges) {
    output.push(
      `# HELP ${name} ${GAUGE_HELP[name]}`,
      `# TYPE ${name} gauge`,
      `${name} ${value}`,
    );
  }
  output.push(
    "# HELP wcm_process_uptime_seconds Process uptime in seconds.",
    "# TYPE wcm_process_uptime_seconds gauge",
    `wcm_process_uptime_seconds ${process.uptime().toFixed(1)}`,
  );
  return `${output.join("\n")}\n`;
}

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"')
    .slice(0, 80);
}
