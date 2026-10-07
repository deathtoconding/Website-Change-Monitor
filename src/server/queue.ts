import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./config.js";
import { shouldRequeueStaleFailedMonitorJob } from "../lib/queue-recovery.js";
import { logger } from "./logger.js";

export interface MonitorJobData {
  monitorId: string;
  userId: string;
  requestId: string;
  trigger: "scheduled" | "initial" | "manual";
}

export interface NotificationJobData {
  outboxId: string;
  changeId: string;
  requestId: string;
}

export interface SystemNotificationJobData {
  outboxId: string;
  requestId: string;
}

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
});

// Control-plane operations must fail promptly when Redis is unavailable instead
// of being queued indefinitely like BullMQ commands.
export const redisControl = redis.duplicate({
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

redis.on("error", (error) => {
  logger.error(
    { errorCode: "REDIS_CONNECTION_ERROR", err: error },
    "Redis connection error",
  );
});

redisControl.on("error", (error) => {
  logger.error(
    { errorCode: "REDIS_CONTROL_CONNECTION_ERROR", err: error },
    "Redis control connection error",
  );
});

const defaultJobOptions = {
  attempts: 4,
  backoff: { type: "wcm-exponential", delay: 30_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600, count: 5_000 },
} as const;

export const monitorQueue = new Queue<MonitorJobData>("monitor-checks", {
  connection: redis,
  defaultJobOptions,
});

export const notificationQueue = new Queue<NotificationJobData>(
  "change-notifications",
  {
    connection: redis,
    defaultJobOptions,
  },
);

export const systemNotificationQueue = new Queue<SystemNotificationJobData>(
  "system-notifications",
  {
    connection: redis,
    defaultJobOptions,
  },
);

export async function enqueueMonitorCheck(
  data: MonitorJobData,
  scheduledAt = new Date(),
): Promise<void> {
  const scheduledAtMs = scheduledAt.getTime();
  const jobId = `monitor-${data.monitorId}-${scheduledAtMs}`;
  const existing = await monitorQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    // Allow the worker's failed-event handler to persist monitor state before recycling a terminal job.
    const staleAfterMs = Math.max(env.schedulerIntervalMs * 5, 120_000);
    if (
      !shouldRequeueStaleFailedMonitorJob(
        state,
        existing.finishedOn,
        Date.now(),
        staleAfterMs,
      )
    )
      return;

    await existing.remove();
    logger.warn(
      {
        jobId,
        monitorId: data.monitorId,
        userId: data.userId,
        staleAfterMs,
        errorCode: "STALE_FAILED_MONITOR_JOB_RECOVERED",
      },
      "Re-queueing due monitor check after its prior job remained failed",
    );
  }
  await monitorQueue.add("check-monitor", data, { jobId });
}

export async function enqueueManualMonitorCheck(
  data: MonitorJobData,
): Promise<void> {
  const key = `wcm:manual-check:${data.monitorId}`;
  const reserved = await redis.set(key, data.requestId, "PX", 60_000, "NX");
  if (reserved !== "OK") {
    const error = new Error(
      "A manual check was requested recently. Wait a minute before trying again.",
    ) as Error & { code: string };
    error.name = "ManualCheckRateLimitError";
    error.code = "MANUAL_CHECK_RATE_LIMIT";
    throw error;
  }
  try {
    await monitorQueue.add("check-monitor", data, {
      ...defaultJobOptions,
      jobId: `manual-${data.monitorId}-${data.requestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32)}`,
    });
  } catch (error) {
    const release = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
    await redis.eval(release, 1, key, data.requestId).catch(() => undefined);
    throw error;
  }
}

export async function enqueueNotification(
  data: NotificationJobData,
): Promise<void> {
  await notificationQueue.add("send-change-email", data, {
    ...defaultJobOptions,
    jobId: `notify-${data.changeId}`,
  });
}

export async function enqueueSystemNotification(
  data: SystemNotificationJobData,
): Promise<void> {
  await systemNotificationQueue.add("send-system-email", data, {
    ...defaultJobOptions,
    jobId: `system-notify-${data.outboxId}`,
  });
}

export async function acquireDomainSlot(
  hostname: string,
  cooldownMs = env.fetchDomainCooldownMs,
): Promise<() => Promise<void>> {
  const key = `wcm:domain:${hostname.toLowerCase()}`;
  const token = randomUUID();
  const maximumRedirectChainMs =
    env.fetchTimeoutMs * (env.fetchMaxRedirects + 1);
  const lockTtl = maximumRedirectChainMs + cooldownMs + 5_000;
  const result = await redis.set(key, token, "PX", lockTtl, "NX");
  if (result !== "OK") {
    const error = new Error(
      "A request to this website is already in progress or was just completed.",
    ) as Error & { code: string; retryable: boolean };
    error.name = "DomainRateLimitError";
    error.code = "DOMAIN_RATE_LIMIT";
    error.retryable = true;
    throw error;
  }

  return async () => {
    const cooldownLua = `if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('psetex', KEYS[1], ARGV[2], 'cooldown'); return 1 else return 0 end`;
    await redis
      .eval(cooldownLua, 1, key, token, String(cooldownMs))
      .catch((error: unknown) => {
        logger.warn(
          { errorCode: "DOMAIN_LOCK_RELEASE_FAILED" },
          "Could not finalize website rate-limit lock",
        );
        throw error;
      });
  };
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([
    monitorQueue.close(),
    notificationQueue.close(),
    systemNotificationQueue.close(),
  ]);
  await Promise.allSettled([redis.quit(), redisControl.quit()]);
}
