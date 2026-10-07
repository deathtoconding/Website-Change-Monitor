import { and, asc, eq, lte } from "drizzle-orm";
import { db, closeDatabase } from "./db/index.js";
import { buildExpiredSnapshotDeletionQuery } from "./db/snapshot-retention.js";
import {
  monitors,
  notificationOutbox,
  systemNotificationOutbox,
} from "./db/schema.js";
import { env } from "./config.js";
import { logger } from "./logger.js";
import {
  closeQueues,
  enqueueMonitorCheck,
  enqueueNotification,
  enqueueSystemNotification,
  redis,
} from "./queue.js";
import { queueWeeklyDigests } from "./services/system-notifications.js";
import { randomUUID } from "node:crypto";

const lockKey = "wcm:scheduler:leader-lock";
let stopping = false;
let timer: NodeJS.Timeout | undefined;

async function scheduleDueWork(): Promise<void> {
  const token = randomUUID();
  const lock = await redis.set(
    lockKey,
    token,
    "PX",
    Math.max(30_000, env.schedulerIntervalMs * 5),
    "NX",
  );
  if (lock !== "OK") return;

  try {
    const now = new Date();
    const dueMonitors = await db
      .select({
        id: monitors.id,
        userId: monitors.userId,
        nextCheckAt: monitors.nextCheckAt,
      })
      .from(monitors)
      .where(and(eq(monitors.status, "active"), lte(monitors.nextCheckAt, now)))
      .orderBy(asc(monitors.nextCheckAt))
      .limit(1_000);
    for (const monitor of dueMonitors) {
      if (!monitor.nextCheckAt) continue;
      try {
        await enqueueMonitorCheck(
          {
            monitorId: monitor.id,
            userId: monitor.userId,
            requestId: randomUUID(),
            trigger: "scheduled",
          },
          monitor.nextCheckAt,
        );
      } catch {
        logger.error(
          {
            monitorId: monitor.id,
            userId: monitor.userId,
            errorCode: "SCHEDULE_ENQUEUE_FAILED",
          },
          "Could not enqueue scheduled monitor check",
        );
      }
    }

    const pendingNotifications = await db
      .select({
        id: notificationOutbox.id,
        changeId: notificationOutbox.changeId,
      })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.status, "pending"))
      .orderBy(asc(notificationOutbox.createdAt))
      .limit(500);
    for (const notification of pendingNotifications) {
      try {
        await enqueueNotification({
          outboxId: notification.id,
          changeId: notification.changeId,
          requestId: randomUUID(),
        });
      } catch {
        logger.error(
          {
            outboxId: notification.id,
            errorCode: "NOTIFICATION_ENQUEUE_FAILED",
          },
          "Could not enqueue pending email notification",
        );
      }
    }

    const weeklyDigestsCreated = await queueWeeklyDigests(now);
    const pendingSystemNotifications = await db
      .select({ id: systemNotificationOutbox.id })
      .from(systemNotificationOutbox)
      .where(eq(systemNotificationOutbox.status, "pending"))
      .orderBy(asc(systemNotificationOutbox.createdAt))
      .limit(500);
    for (const notification of pendingSystemNotifications) {
      try {
        await enqueueSystemNotification({
          outboxId: notification.id,
          requestId: randomUUID(),
        });
      } catch {
        logger.error(
          {
            outboxId: notification.id,
            errorCode: "SYSTEM_NOTIFICATION_ENQUEUE_FAILED",
          },
          "Could not enqueue pending system notification",
        );
      }
    }

    await pruneExpiredSnapshots(now);
    logger.debug(
      {
        dueMonitors: dueMonitors.length,
        pendingNotifications: pendingNotifications.length,
        weeklyDigestsCreated,
        pendingSystemNotifications: pendingSystemNotifications.length,
      },
      "Scheduler tick completed",
    );
  } finally {
    const releaseScript = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
    await redis.eval(releaseScript, 1, lockKey, token).catch(() => {
      logger.warn(
        { errorCode: "SCHEDULER_LOCK_RELEASE_FAILED" },
        "Scheduler lock will expire automatically",
      );
    });
  }
}

async function pruneExpiredSnapshots(now: Date): Promise<void> {
  const dateKey = now.toISOString().slice(0, 10);
  const key = `wcm:snapshot-retention:${dateKey}`;
  const acquired = await redis.set(key, "running", "EX", 24 * 60 * 60, "NX");
  if (acquired !== "OK") return;

  let deleted = 0;
  try {
    for (let batch = 0; batch < 20; batch += 1) {
      const result = await db.execute(buildExpiredSnapshotDeletionQuery(now));
      const removed = result.rows.length;
      deleted += removed;
      if (removed < 1000) break;
    }
    if (deleted >= 20_000) await redis.del(key);
    if (deleted > 0)
      logger.info(
        {
          snapshotsDeleted: deleted,
          retentionDays: { free: 7, starter: 30, business: 365 },
        },
        "Expired snapshots pruned",
      );
  } catch (error) {
    await redis.del(key).catch(() => undefined);
    throw error;
  }
}

async function tick() {
  if (stopping) return;
  try {
    await scheduleDueWork();
  } catch (error) {
    logger.error(
      { errorCode: "SCHEDULER_TICK_FAILED", err: error },
      "Scheduler tick failed; next tick will retry",
    );
  } finally {
    if (!stopping)
      timer = setTimeout(() => {
        void tick();
      }, env.schedulerIntervalMs);
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  logger.info({ signal }, "Shutting down scheduler");
  await closeQueues();
  await closeDatabase();
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void tick();
logger.info(
  { intervalMs: env.schedulerIntervalMs },
  "Durable monitor scheduler started",
);
