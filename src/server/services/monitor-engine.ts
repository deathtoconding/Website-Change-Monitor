import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import {
  failureNotificationDedupeKey,
  PERSISTENT_FAILURE_THRESHOLD,
  shouldNotifyForPersistentFailure,
} from "../../lib/notifications.js";
import { diffText, nextCheckDate } from "../../lib/monitoring.js";
import { canCommitMonitorFetch } from "../../lib/monitor-check-guard.js";
import type { DiffLine } from "../../lib/types.js";
import { db } from "../db/index.js";
import {
  changes,
  monitors,
  notificationOutbox,
  notificationPreferences,
  snapshots,
  systemNotificationOutbox,
  users,
} from "../db/schema.js";
import {
  acquireDomainSlot,
  enqueueNotification,
  type MonitorJobData,
} from "../queue.js";
import { DnsResolutionError, UrlSafetyError } from "../security/url-safety.js";
import { ContentExtractionError, extractText } from "./extract-content.js";
import { FetchError, fetchPage } from "./http-fetcher.js";
import { logger } from "../logger.js";
import { incrementMetric, observeMetric } from "../metrics.js";

export interface MonitorCheckOutcome {
  status: "skipped" | "success" | "no_change" | "changed";
  changeId?: string;
  notificationQueued?: boolean;
}

export async function executeMonitorCheck(
  job: MonitorJobData,
): Promise<MonitorCheckOutcome> {
  const [candidate] = await db
    .select()
    .from(monitors)
    .where(
      and(
        eq(monitors.id, job.monitorId),
        eq(monitors.userId, job.userId),
        ne(monitors.status, "deleted"),
      ),
    )
    .limit(1);

  if (!candidate || candidate.status !== "active") {
    logger.info(
      {
        requestId: job.requestId,
        monitorId: job.monitorId,
        userId: job.userId,
        status: "skipped",
      },
      "Monitor check skipped",
    );
    return { status: "skipped" };
  }

  const heldDomainSlots = new Map<string, () => Promise<void>>();
  const beforeRequest = async (url: URL) => {
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!heldDomainSlots.has(host))
      heldDomainSlots.set(host, await acquireDomainSlot(host));
  };
  const releaseDomainSlots = async () => {
    for (const release of [...heldDomainSlots.values()].reverse())
      await release().catch(() => undefined);
    heldDomainSlots.clear();
  };
  const startedAt = Date.now();
  try {
    let fetched;
    try {
      fetched = await fetchPage(candidate.url, { beforeRequest });
    } catch (error) {
      if (error instanceof DnsResolutionError)
        throw new FetchError(error.code, error.message, true);
      if (error instanceof UrlSafetyError)
        throw new FetchError(error.code, error.message, false);
      throw error;
    } finally {
      await releaseDomainSlots();
    }

    let content: string;
    try {
      content = extractText(fetched.html, candidate.selector);
    } catch (error) {
      if (error instanceof ContentExtractionError)
        throw new FetchError(error.code, error.message, false);
      throw error;
    }
    const contentHash = createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(monitors)
        .where(
          and(eq(monitors.id, candidate.id), eq(monitors.userId, job.userId)),
        )
        .for("update")
        .limit(1);

      if (!locked || !canCommitMonitorFetch(candidate, locked))
        return { status: "skipped" as const };

      const [snapshot] = await tx
        .insert(snapshots)
        .values({
          monitorId: locked.id,
          content,
          contentHash,
          httpStatus: fetched.httpStatus,
          contentType: fetched.contentType,
          responseTimeMs: fetched.responseTimeMs,
          fetchedAt: fetched.fetchedAt,
        })
        .returning();

      const previousHash = locked.currentHash;
      const previousSnapshotId = locked.currentSnapshotId;
      const changed = Boolean(
        previousHash && previousHash !== contentHash && previousSnapshotId,
      );
      let changeId: string | undefined;
      let notificationQueued = false;

      if (changed && previousSnapshotId) {
        const [previousSnapshot] = await tx
          .select({ content: snapshots.content })
          .from(snapshots)
          .where(
            and(
              eq(snapshots.id, previousSnapshotId),
              eq(snapshots.monitorId, locked.id),
            ),
          )
          .limit(1);
        const diff: DiffLine[] = diffText(
          previousSnapshot?.content ?? "",
          content,
        );
        const [preference] = await tx
          .select({ emailAlerts: notificationPreferences.emailAlerts })
          .from(notificationPreferences)
          .where(eq(notificationPreferences.userId, locked.userId))
          .limit(1);
        const alertsEnabled = preference?.emailAlerts ?? true;
        const [owner] = alertsEnabled
          ? await tx
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, locked.userId))
              .limit(1)
          : [];
        const shouldNotify = Boolean(alertsEnabled && owner?.email);
        const [change] = await tx
          .insert(changes)
          .values({
            monitorId: locked.id,
            previousSnapshotId,
            newSnapshotId: snapshot.id,
            diff,
            detectedAt: now,
            notificationStatus: shouldNotify ? "pending" : "not_configured",
          })
          .returning({ id: changes.id });
        changeId = change.id;

        if (shouldNotify && owner) {
          const [outbox] = await tx
            .insert(notificationOutbox)
            .values({
              changeId: change.id,
              userId: locked.userId,
              recipientEmail: owner.email,
              status: "pending",
            })
            .returning({ id: notificationOutbox.id });
          notificationQueued = Boolean(outbox);
        }
      }

      await tx
        .update(monitors)
        .set({
          currentHash: contentHash,
          currentSnapshotId: snapshot.id,
          lastCheckedAt: now,
          lastChangedAt: changed ? now : locked.lastChangedAt,
          nextCheckAt: nextCheckDate(now, locked.frequency),
          consecutiveFailures: 0,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(eq(monitors.id, locked.id));

      return {
        status: changed
          ? ("changed" as const)
          : previousHash
            ? ("no_change" as const)
            : ("success" as const),
        changeId,
        notificationQueued,
      };
    });

    incrementMetric("wcm_monitor_checks_total", { result: result.status });
    if (result.status === "changed")
      incrementMetric("wcm_changes_detected_total");
    if (result.notificationQueued && result.changeId) {
      const [outbox] = await db
        .select({ id: notificationOutbox.id })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.changeId, result.changeId))
        .limit(1);
      if (outbox) {
        await enqueueNotification({
          outboxId: outbox.id,
          changeId: result.changeId,
          requestId: job.requestId,
        });
      }
    }

    logger.info(
      {
        requestId: job.requestId,
        jobId: `monitor-${job.monitorId}`,
        monitorId: job.monitorId,
        userId: job.userId,
        duration: Date.now() - startedAt,
        status: result.status,
        errorCode: undefined,
      },
      "Monitor check completed",
    );
    return result;
  } catch (error) {
    const errorCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "CHECK_FAILED";
    incrementMetric("wcm_monitor_check_failures_total", { code: errorCode });
    throw error;
  } finally {
    observeMetric(
      "wcm_monitor_check_duration_seconds",
      (Date.now() - startedAt) / 1_000,
    );
  }
}

export async function recordMonitorFailure(
  job: MonitorJobData,
  error: unknown,
): Promise<void> {
  const errorCode =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "CHECK_FAILED";
  const now = new Date();
  const dedupeKey = failureNotificationDedupeKey(job.monitorId, job.requestId);
  const failureCount = await db.transaction(async (tx) => {
    const [monitor] = await tx
      .select({
        id: monitors.id,
        userId: monitors.userId,
        name: monitors.name,
        url: monitors.url,
        status: monitors.status,
        frequency: monitors.frequency,
        consecutiveFailures: monitors.consecutiveFailures,
      })
      .from(monitors)
      .where(
        and(eq(monitors.id, job.monitorId), eq(monitors.userId, job.userId)),
      )
      .for("update")
      .limit(1);
    if (
      !monitor ||
      monitor.status === "deleted" ||
      monitor.status === "paused" ||
      monitor.status === "error"
    )
      return null;

    const [alreadyRecorded] = await tx
      .select({ id: systemNotificationOutbox.id })
      .from(systemNotificationOutbox)
      .where(eq(systemNotificationOutbox.dedupeKey, dedupeKey))
      .limit(1);
    if (alreadyRecorded) return null;

    const [owner] = await tx
      .select({ email: users.email, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, monitor.userId))
      .limit(1);
    if (!owner) return null;

    const [preference] = await tx
      .select({ failureAlerts: notificationPreferences.failureAlerts })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, monitor.userId))
      .limit(1);

    const nextFailureCount = monitor.consecutiveFailures + 1;
    const reachedPersistentFailure =
      nextFailureCount >= PERSISTENT_FAILURE_THRESHOLD;
    const preferenceEnabled = preference?.failureAlerts ?? true;
    const shouldQueueEmail =
      shouldNotifyForPersistentFailure(nextFailureCount, preferenceEnabled) &&
      Boolean(owner.emailVerifiedAt);

    await tx
      .update(monitors)
      .set({
        status: reachedPersistentFailure ? "error" : "active",
        consecutiveFailures: nextFailureCount,
        lastErrorCode: errorCode,
        nextCheckAt: reachedPersistentFailure
          ? null
          : nextCheckDate(now, monitor.frequency),
        updatedAt: now,
      })
      .where(and(eq(monitors.id, monitor.id), eq(monitors.userId, job.userId)));

    await tx
      .insert(systemNotificationOutbox)
      .values({
        userId: monitor.userId,
        monitorId: monitor.id,
        kind: "failure",
        dedupeKey,
        recipientEmail: owner.email,
        payload: {
          monitorName: monitor.name,
          url: monitor.url,
          monitorId: monitor.id,
          consecutiveFailures: nextFailureCount,
          lastErrorCode: errorCode,
          occurredAt: now.toISOString(),
        },
        status: shouldQueueEmail ? "pending" : "skipped",
        lastErrorCode: shouldQueueEmail
          ? null
          : !reachedPersistentFailure
            ? "BELOW_FAILURE_THRESHOLD"
            : !preferenceEnabled
              ? "PREFERENCE_DISABLED"
              : "EMAIL_UNVERIFIED",
      })
      .onConflictDoNothing({ target: systemNotificationOutbox.dedupeKey });

    return nextFailureCount;
  });

  if (failureCount === null) return;
  logger.error(
    {
      requestId: job.requestId,
      jobId: `monitor-${job.monitorId}`,
      monitorId: job.monitorId,
      userId: job.userId,
      status:
        failureCount >= PERSISTENT_FAILURE_THRESHOLD
          ? "failed"
          : "retry_exhausted",
      errorCode,
    },
    "Monitor check failed after queue retries",
  );
}

export async function markOutboxFailed(
  outboxId: string,
  error: unknown,
): Promise<void> {
  const errorCode =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "EMAIL_DELIVERY_FAILED";
  const [outbox] = await db
    .select({ changeId: notificationOutbox.changeId })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.id, outboxId))
    .limit(1);
  if (!outbox) return;
  await db
    .update(notificationOutbox)
    .set({ status: "failed", lastErrorCode: errorCode, updatedAt: new Date() })
    .where(eq(notificationOutbox.id, outboxId));
  await db
    .update(changes)
    .set({ notificationStatus: "failed" })
    .where(eq(changes.id, outbox.changeId));
}
