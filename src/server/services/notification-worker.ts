import { Worker, type Job } from "bullmq";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  changes,
  monitors,
  notificationOutbox,
  notificationPreferences,
  systemNotificationOutbox,
  users,
} from "../db/schema.js";
import type {
  FailureNotificationPayload,
  WeeklyDigestNotificationPayload,
} from "../db/schema.js";
import { assertEmailIntegrationConfigured, env } from "../config.js";
import {
  redis,
  type NotificationJobData,
  type SystemNotificationJobData,
} from "../queue.js";
import {
  sendChangeEmail,
  sendMonitorFailureEmail,
  sendWeeklyDigestEmail,
} from "./email.js";
import { markOutboxFailed } from "./monitor-engine.js";
import { logger } from "../logger.js";
import { incrementMetric } from "../metrics.js";

assertEmailIntegrationConfigured();

const retryDelays = [30_000, 2 * 60_000, 10 * 60_000];

export const notificationWorker = new Worker<NotificationJobData>(
  "change-notifications",
  sendNotificationJob,
  {
    connection: redis.duplicate(),
    concurrency: Math.max(1, Math.min(env.workerConcurrency, 8)),
    settings: {
      backoffStrategy: (attemptsMade, type) =>
        type === "wcm-exponential"
          ? (retryDelays[attemptsMade - 1] ?? 10 * 60_000)
          : -1,
    },
  },
);

notificationWorker.on("completed", (job) => {
  logger.info(
    { requestId: job.data.requestId, jobId: job.id, status: "success" },
    "Notification job completed",
  );
});

notificationWorker.on("failed", (job, error) => {
  if (!job) return;
  logger.error(
    {
      requestId: job.data.requestId,
      jobId: job.id,
      errorCode: getErrorCode(error),
    },
    "Notification attempt failed",
  );
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void markOutboxFailed(job.data.outboxId, error).catch(() => {
      logger.error(
        {
          requestId: job.data.requestId,
          jobId: job.id,
          errorCode: "OUTBOX_FAILURE_UPDATE_FAILED",
        },
        "Could not persist notification failure",
      );
    });
  }
});

notificationWorker.on("error", (error) => {
  logger.error(
    { errorCode: "NOTIFICATION_WORKER_ERROR", err: error },
    "Notification worker error",
  );
});

async function sendNotificationJob(
  job: Job<NotificationJobData>,
): Promise<void> {
  const [row] = await db
    .select({
      outbox: notificationOutbox,
      change: changes,
      monitor: monitors,
    })
    .from(notificationOutbox)
    .innerJoin(changes, eq(notificationOutbox.changeId, changes.id))
    .innerJoin(monitors, eq(changes.monitorId, monitors.id))
    .where(
      and(
        eq(notificationOutbox.id, job.data.outboxId),
        eq(notificationOutbox.changeId, job.data.changeId),
      ),
    )
    .limit(1);

  if (!row || ["sent", "failed", "not_configured"].includes(row.outbox.status))
    return;
  if (row.monitor.status === "deleted") {
    await db
      .update(notificationOutbox)
      .set({
        status: "failed",
        lastErrorCode: "MONITOR_DELETED",
        updatedAt: new Date(),
      })
      .where(eq(notificationOutbox.id, row.outbox.id));
    await db
      .update(changes)
      .set({ notificationStatus: "failed" })
      .where(eq(changes.id, row.change.id));
    return;
  }

  if (!env.resendApiKey) {
    await db
      .update(notificationOutbox)
      .set({ status: "not_configured", updatedAt: new Date() })
      .where(eq(notificationOutbox.id, row.outbox.id));
    await db
      .update(changes)
      .set({ notificationStatus: "not_configured" })
      .where(eq(changes.id, row.change.id));
    incrementMetric("wcm_change_notifications_total", {
      result: "not_configured",
    });
    logger.info(
      {
        requestId: job.data.requestId,
        jobId: job.id,
        monitorId: row.monitor.id,
        status: "not_configured",
      },
      "Email provider is not configured; notification retained as skipped",
    );
    return;
  }

  try {
    const providerMessageId = await sendChangeEmail({
      to: row.outbox.recipientEmail,
      monitorName: row.monitor.name,
      url: row.monitor.url,
      detectedAt: row.change.detectedAt,
      changeId: row.change.id,
      diff: row.change.diff,
    });
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(notificationOutbox)
        .set({
          status: "sent",
          providerMessageId,
          attempts: row.outbox.attempts + 1,
          sentAt: now,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(eq(notificationOutbox.id, row.outbox.id));
      await tx
        .update(changes)
        .set({ notificationStatus: "sent" })
        .where(eq(changes.id, row.change.id));
    });
    incrementMetric("wcm_change_notifications_total", { result: "sent" });
  } catch (error) {
    const errorCode = getErrorCode(error);
    incrementMetric("wcm_change_notifications_total", { result: "failed" });
    await db
      .update(notificationOutbox)
      .set({
        attempts: row.outbox.attempts + 1,
        lastErrorCode: errorCode,
        updatedAt: new Date(),
      })
      .where(eq(notificationOutbox.id, row.outbox.id));
    throw error;
  }
}

function getErrorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "EMAIL_DELIVERY_FAILED";
}

export const systemNotificationWorker = new Worker<SystemNotificationJobData>(
  "system-notifications",
  sendSystemNotificationJob,
  {
    connection: redis.duplicate(),
    concurrency: Math.max(1, Math.min(env.workerConcurrency, 8)),
    settings: {
      backoffStrategy: (attemptsMade, type) =>
        type === "wcm-exponential"
          ? (retryDelays[attemptsMade - 1] ?? 10 * 60_000)
          : -1,
    },
  },
);

systemNotificationWorker.on("completed", (job) => {
  logger.info(
    { requestId: job.data.requestId, jobId: job.id, status: "success" },
    "System email notification job completed",
  );
});

systemNotificationWorker.on("failed", (job, error) => {
  if (!job) return;
  logger.error(
    {
      requestId: job.data.requestId,
      jobId: job.id,
      errorCode: getErrorCode(error),
    },
    "System email notification attempt failed",
  );
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void markSystemNotificationFailed(job.data.outboxId, error).catch(() => {
      logger.error(
        {
          requestId: job.data.requestId,
          jobId: job.id,
          errorCode: "SYSTEM_OUTBOX_FAILURE_UPDATE_FAILED",
        },
        "Could not persist system notification failure",
      );
    });
  }
});

systemNotificationWorker.on("error", (error) => {
  logger.error(
    { errorCode: "SYSTEM_NOTIFICATION_WORKER_ERROR", err: error },
    "System notification worker error",
  );
});

async function sendSystemNotificationJob(
  job: Job<SystemNotificationJobData>,
): Promise<void> {
  const [row] = await db
    .select({
      outbox: systemNotificationOutbox,
      preferences: notificationPreferences,
      emailVerifiedAt: users.emailVerifiedAt,
      monitorStatus: monitors.status,
    })
    .from(systemNotificationOutbox)
    .innerJoin(users, eq(systemNotificationOutbox.userId, users.id))
    .leftJoin(
      notificationPreferences,
      eq(systemNotificationOutbox.userId, notificationPreferences.userId),
    )
    .leftJoin(monitors, eq(systemNotificationOutbox.monitorId, monitors.id))
    .where(eq(systemNotificationOutbox.id, job.data.outboxId))
    .limit(1);

  if (
    !row ||
    row.outbox.status === "sent" ||
    row.outbox.status === "failed" ||
    row.outbox.status === "not_configured" ||
    row.outbox.status === "skipped"
  )
    return;

  const preferenceEnabled =
    row.outbox.kind === "failure"
      ? (row.preferences?.failureAlerts ?? true)
      : (row.preferences?.weeklyDigest ?? false);
  if (!preferenceEnabled || !row.emailVerifiedAt) {
    await skipSystemNotification(
      row.outbox.id,
      preferenceEnabled ? "EMAIL_UNVERIFIED" : "PREFERENCE_DISABLED",
    );
    return;
  }
  if (
    row.outbox.kind === "failure" &&
    (row.monitorStatus === "deleted" || row.monitorStatus === null)
  ) {
    await skipSystemNotification(row.outbox.id, "MONITOR_DELETED");
    return;
  }

  let digestChanges: WeeklyDigestNotificationPayload["changes"] | undefined;
  if (row.outbox.kind === "weekly_digest") {
    const payload = row.outbox.payload as WeeklyDigestNotificationPayload;
    const changeIds = payload.changes.map((change) => change.changeId);
    const activeChanges = changeIds.length
      ? await db
          .select({ id: changes.id })
          .from(changes)
          .innerJoin(monitors, eq(changes.monitorId, monitors.id))
          .where(
            and(
              eq(monitors.userId, row.outbox.userId),
              ne(monitors.status, "deleted"),
              inArray(changes.id, changeIds),
            ),
          )
      : [];
    const activeChangeIds = new Set(activeChanges.map((change) => change.id));
    digestChanges = payload.changes.filter((change) =>
      activeChangeIds.has(change.changeId),
    );
    if (digestChanges.length === 0) {
      await skipSystemNotification(row.outbox.id, "NO_REMAINING_CHANGES");
      return;
    }
  }

  if (!env.resendApiKey) {
    await db
      .update(systemNotificationOutbox)
      .set({ status: "not_configured", updatedAt: new Date() })
      .where(eq(systemNotificationOutbox.id, row.outbox.id));
    incrementMetric("wcm_system_notifications_total", {
      kind: row.outbox.kind,
      result: "not_configured",
    });
    logger.info(
      {
        requestId: job.data.requestId,
        jobId: job.id,
        kind: row.outbox.kind,
        status: "not_configured",
      },
      "Email provider is not configured; system notification retained as skipped",
    );
    return;
  }

  try {
    let providerMessageId: string | null;
    if (row.outbox.kind === "failure") {
      const payload = row.outbox.payload as FailureNotificationPayload;
      providerMessageId = await sendMonitorFailureEmail({
        to: row.outbox.recipientEmail,
        ...payload,
        dedupeKey: row.outbox.dedupeKey,
      });
    } else {
      const payload = row.outbox.payload as WeeklyDigestNotificationPayload;
      providerMessageId = await sendWeeklyDigestEmail({
        to: row.outbox.recipientEmail,
        ...payload,
        changes: digestChanges ?? [],
        dedupeKey: row.outbox.dedupeKey,
      });
    }

    const now = new Date();
    await db
      .update(systemNotificationOutbox)
      .set({
        status: "sent",
        providerMessageId,
        attempts: row.outbox.attempts + 1,
        sentAt: now,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(eq(systemNotificationOutbox.id, row.outbox.id));
    incrementMetric("wcm_system_notifications_total", {
      kind: row.outbox.kind,
      result: "sent",
    });
  } catch (error) {
    await db
      .update(systemNotificationOutbox)
      .set({
        attempts: row.outbox.attempts + 1,
        lastErrorCode: getErrorCode(error),
        updatedAt: new Date(),
      })
      .where(eq(systemNotificationOutbox.id, row.outbox.id));
    incrementMetric("wcm_system_notifications_total", {
      kind: row.outbox.kind,
      result: "failed",
    });
    throw error;
  }
}

async function skipSystemNotification(
  outboxId: string,
  reason: string,
): Promise<void> {
  await db
    .update(systemNotificationOutbox)
    .set({ status: "skipped", lastErrorCode: reason, updatedAt: new Date() })
    .where(
      and(
        eq(systemNotificationOutbox.id, outboxId),
        eq(systemNotificationOutbox.status, "pending"),
      ),
    );
}

async function markSystemNotificationFailed(
  outboxId: string,
  error: unknown,
): Promise<void> {
  await db
    .update(systemNotificationOutbox)
    .set({
      status: "failed",
      lastErrorCode: getErrorCode(error),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(systemNotificationOutbox.id, outboxId),
        eq(systemNotificationOutbox.status, "pending"),
      ),
    );
}
