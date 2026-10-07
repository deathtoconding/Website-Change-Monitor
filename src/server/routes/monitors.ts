import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { getSuggestedName, nextCheckDate } from "../../lib/monitoring.js";
import { db } from "../db/index.js";
import { monitorOwnedAndNotDeleted } from "../db/monitor-conditions.js";
import {
  changes,
  monitors,
  notificationOutbox,
  notificationPreferences,
  snapshots,
  subscriptions,
  users,
} from "../db/schema.js";
import { asyncRoute, requireAuth, requireCsrf } from "../middleware.js";
import { enqueueManualMonitorCheck, enqueueMonitorCheck } from "../queue.js";
import {
  canAddMonitor,
  MONITOR_LIMITS,
  resolveEffectivePlan,
} from "../services/plan-limits.js";
import { validateSelector } from "../services/extract-content.js";
import {
  assertSafeHttpUrl,
  normalizeHttpUrl,
  UrlSafetyError,
  DnsResolutionError,
} from "../security/url-safety.js";
import { logger } from "../logger.js";

export const monitorRouter = Router();
const frequencySchema = z.enum(["hourly", "six-hourly", "daily"]);
const createSchema = z.object({
  name: z.string().trim().max(80).optional().default(""),
  url: z.string().trim().min(1).max(2_048),
  frequency: frequencySchema.default("daily"),
  selector: z.string().trim().max(160).optional().default(""),
});
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    url: z.string().trim().min(1).max(2_048).optional(),
    frequency: frequencySchema.optional(),
    selector: z.string().trim().max(160).optional(),
  })
  .strict();

monitorRouter.get(
  "/monitors",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.authUser!.id;
    const rows = await db
      .select()
      .from(monitors)
      .where(and(eq(monitors.userId, userId), ne(monitors.status, "deleted")))
      .orderBy(desc(monitors.createdAt));
    const checks = rows.length
      ? await db
          .select({ monitorId: snapshots.monitorId, count: count() })
          .from(snapshots)
          .innerJoin(monitors, eq(snapshots.monitorId, monitors.id))
          .where(
            and(eq(monitors.userId, userId), ne(monitors.status, "deleted")),
          )
          .groupBy(snapshots.monitorId)
      : [];
    const checkCounts = new Map(
      checks.map((row) => [row.monitorId, row.count]),
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({
      monitors: rows.map((monitor) => ({
        ...monitor,
        checkCount: checkCounts.get(monitor.id) ?? 0,
      })),
    });
  }),
);

monitorRouter.post(
  "/monitors",
  requireAuth,
  requireCsrf,
  asyncRoute(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Provide a valid HTTP(S) URL, a name of up to 80 characters, and a CSS selector of up to 160 characters.",
      });
      return;
    }
    const selectorError = validateSelector(parsed.data.selector);
    if (selectorError) {
      res.status(400).json({ error: selectorError });
      return;
    }
    let normalizedUrl: URL;
    try {
      normalizedUrl = normalizeHttpUrl(parsed.data.url);
      // Validate DNS now to fail closed at creation; the worker repeats this immediately before every connection.
      await assertSafeHttpUrl(normalizedUrl.toString());
    } catch (error) {
      const message =
        error instanceof UrlSafetyError || error instanceof DnsResolutionError
          ? error.message
          : "The URL could not be validated safely.";
      res.status(error instanceof DnsResolutionError ? 422 : 400).json({
        error: message,
        code:
          error instanceof Error && "code" in error
            ? error.code
            : "INVALID_URL",
      });
      return;
    }

    const now = new Date();
    const creation = await db.transaction(async (tx) => {
      const [lockedUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, req.authUser!.id))
        .for("update")
        .limit(1);
      if (!lockedUser)
        return {
          allowed: false as const,
          plan: "free" as const,
          limit: MONITOR_LIMITS.free,
          current: 0,
          monitor: null,
        };

      const subscriptionRows = await tx
        .select({
          plan: subscriptions.plan,
          status: subscriptions.status,
          periodEnd: subscriptions.currentPeriodEnd,
        })
        .from(subscriptions)
        .where(eq(subscriptions.userId, lockedUser.id))
        .orderBy(desc(subscriptions.updatedAt));
      const plan = resolveEffectivePlan(subscriptionRows);
      const limit = MONITOR_LIMITS[plan];
      const [monitorCount] = await tx
        .select({ count: count() })
        .from(monitors)
        .where(
          and(
            eq(monitors.userId, lockedUser.id),
            ne(monitors.status, "deleted"),
          ),
        );
      const current = monitorCount?.count ?? 0;
      if (current >= limit)
        return { allowed: false as const, plan, limit, current, monitor: null };

      const [monitor] = await tx
        .insert(monitors)
        .values({
          userId: lockedUser.id,
          name: parsed.data.name || getSuggestedName(normalizedUrl.toString()),
          url: normalizedUrl.toString(),
          frequency: parsed.data.frequency,
          selector: parsed.data.selector,
          status: "active",
          nextCheckAt: now,
        })
        .returning();
      return {
        allowed: true as const,
        plan,
        limit,
        current: current + 1,
        monitor: monitor ?? null,
      };
    });

    if (!creation.allowed || !creation.monitor) {
      res.status(403).json({
        error: `Your ${creation.plan} plan allows ${creation.limit} monitors. Upgrade or remove a monitor to continue.`,
        code: "PLAN_LIMIT",
        plan: creation.plan,
        limit: creation.limit,
        current: creation.current,
      });
      return;
    }
    const monitor = creation.monitor;

    try {
      await enqueueMonitorCheck(
        {
          monitorId: monitor.id,
          userId: req.authUser!.id,
          requestId: req.requestId ?? randomUUID(),
          trigger: "initial",
        },
        now,
      );
    } catch {
      // The durable database schedule is the source of truth; the scheduler will enqueue it after Redis recovers.
      logger.error(
        {
          requestId: req.requestId,
          monitorId: monitor.id,
          userId: req.authUser!.id,
          errorCode: "INITIAL_JOB_ENQUEUE_FAILED",
        },
        "Initial monitor job will be recovered by scheduler",
      );
    }
    res.status(201).json({ monitor });
  }),
);

monitorRouter.get(
  "/monitors/:monitorId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const monitorId = resourceId(req, res, "monitorId");
    if (!monitorId) return;
    const [monitor] = await db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.id, monitorId),
          eq(monitors.userId, req.authUser!.id),
          ne(monitors.status, "deleted"),
        ),
      )
      .limit(1);
    if (!monitor) {
      res.status(404).json({ error: "Monitor not found." });
      return;
    }
    const [currentSnapshot] = monitor.currentSnapshotId
      ? await db
          .select({
            id: snapshots.id,
            content: snapshots.content,
            contentHash: snapshots.contentHash,
            httpStatus: snapshots.httpStatus,
            contentType: snapshots.contentType,
            fetchedAt: snapshots.fetchedAt,
          })
          .from(snapshots)
          .where(
            and(
              eq(snapshots.id, monitor.currentSnapshotId),
              eq(snapshots.monitorId, monitor.id),
            ),
          )
          .limit(1)
      : [];
    const history = await db
      .select({
        id: changes.id,
        detectedAt: changes.detectedAt,
        notificationStatus: changes.notificationStatus,
      })
      .from(changes)
      .where(eq(changes.monitorId, monitor.id))
      .orderBy(desc(changes.detectedAt))
      .limit(100);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      monitor,
      currentSnapshot: currentSnapshot ?? null,
      changes: history,
    });
  }),
);

monitorRouter.patch(
  "/monitors/:monitorId",
  requireAuth,
  requireCsrf,
  asyncRoute(async (req, res) => {
    const monitorId = resourceId(req, res, "monitorId");
    if (!monitorId) return;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
      res.status(400).json({
        error: "Provide at least one valid monitor setting to update.",
      });
      return;
    }
    if (parsed.data.selector !== undefined) {
      const selectorError = validateSelector(parsed.data.selector);
      if (selectorError) {
        res.status(400).json({ error: selectorError });
        return;
      }
    }

    const [current] = await db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.id, monitorId),
          eq(monitors.userId, req.authUser!.id),
          ne(monitors.status, "deleted"),
        ),
      )
      .limit(1);
    if (!current) {
      res.status(404).json({ error: "Monitor not found." });
      return;
    }

    let normalizedUrl: URL | undefined;
    if (parsed.data.url !== undefined) {
      try {
        normalizedUrl = normalizeHttpUrl(parsed.data.url);
        await assertSafeHttpUrl(normalizedUrl.toString());
      } catch (error) {
        const message =
          error instanceof UrlSafetyError || error instanceof DnsResolutionError
            ? error.message
            : "The URL could not be validated safely.";
        res.status(error instanceof DnsResolutionError ? 422 : 400).json({
          error: message,
          code:
            error instanceof Error && "code" in error
              ? error.code
              : "INVALID_URL",
        });
        return;
      }
    }

    const now = new Date();
    const frequency = parsed.data.frequency ?? current.frequency;
    const changedFrequency =
      parsed.data.frequency !== undefined &&
      parsed.data.frequency !== current.frequency;
    const baselineReset = Boolean(
      (normalizedUrl && normalizedUrl.toString() !== current.url) ||
      (parsed.data.selector !== undefined &&
        parsed.data.selector !== current.selector),
    );
    const [updated] = await db
      .update(monitors)
      .set({
        ...parsed.data,
        ...(normalizedUrl ? { url: normalizedUrl.toString() } : {}),
        ...(baselineReset
          ? {
              currentHash: null,
              currentSnapshotId: null,
              lastChangedAt: null,
              consecutiveFailures: 0,
              lastErrorCode: null,
            }
          : {}),
        ...(current.status === "active" && baselineReset
          ? { nextCheckAt: now }
          : {}),
        ...(current.status === "active" && !baselineReset && changedFrequency
          ? { nextCheckAt: nextCheckDate(now, frequency) }
          : {}),
        updatedAt: now,
      })
      .where(monitorOwnedAndNotDeleted(current.id, req.authUser!.id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Monitor not found." });
      return;
    }

    if (baselineReset && current.status === "active") {
      try {
        await enqueueMonitorCheck(
          {
            monitorId: current.id,
            userId: req.authUser!.id,
            requestId: req.requestId ?? randomUUID(),
            trigger: "manual",
          },
          now,
        );
      } catch {
        logger.error(
          {
            requestId: req.requestId,
            monitorId: current.id,
            userId: req.authUser!.id,
            errorCode: "BASELINE_REFRESH_ENQUEUE_FAILED",
          },
          "Updated monitor baseline will be recovered by scheduler",
        );
      }
    }
    res.json({ monitor: updated });
  }),
);

monitorRouter.patch(
  "/monitors/:monitorId/status",
  requireAuth,
  requireCsrf,
  asyncRoute(async (req, res) => {
    const monitorId = resourceId(req, res, "monitorId");
    if (!monitorId) return;
    const parsed = z
      .object({ status: z.enum(["active", "paused"]) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Status must be active or paused." });
      return;
    }
    const [current] = await db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.id, monitorId),
          eq(monitors.userId, req.authUser!.id),
          ne(monitors.status, "deleted"),
        ),
      )
      .limit(1);
    if (!current) {
      res.status(404).json({ error: "Monitor not found." });
      return;
    }
    if (current.status === parsed.data.status) {
      res.json({ monitor: current });
      return;
    }
    const now = new Date();
    const [updated] = await db
      .update(monitors)
      .set({
        status: parsed.data.status,
        consecutiveFailures:
          parsed.data.status === "active" ? 0 : current.consecutiveFailures,
        lastErrorCode:
          parsed.data.status === "active" ? null : current.lastErrorCode,
        nextCheckAt: parsed.data.status === "active" ? now : null,
        updatedAt: now,
      })
      .where(monitorOwnedAndNotDeleted(current.id, req.authUser!.id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Monitor not found." });
      return;
    }

    if (parsed.data.status === "active") {
      try {
        await enqueueMonitorCheck(
          {
            monitorId: current.id,
            userId: req.authUser!.id,
            requestId: req.requestId ?? randomUUID(),
            trigger: "manual",
          },
          now,
        );
      } catch {
        logger.error(
          {
            requestId: req.requestId,
            monitorId: current.id,
            userId: req.authUser!.id,
            errorCode: "RESUME_JOB_ENQUEUE_FAILED",
          },
          "Resumed monitor will be recovered by scheduler",
        );
      }
    }
    res.json({ monitor: updated });
  }),
);

monitorRouter.delete(
  "/monitors/:monitorId",
  requireAuth,
  requireCsrf,
  asyncRoute(async (req, res) => {
    const monitorId = resourceId(req, res, "monitorId");
    if (!monitorId) return;
    const now = new Date();
    const deleted = await db.transaction(async (tx) => {
      const [monitor] = await tx
        .update(monitors)
        .set({
          status: "deleted",
          nextCheckAt: null,
          currentHash: null,
          currentSnapshotId: null,
          updatedAt: now,
        })
        .where(monitorOwnedAndNotDeleted(monitorId, req.authUser!.id))
        .returning({ id: monitors.id });
      if (!monitor) return null;

      const monitorChanges = tx
        .select({ id: changes.id })
        .from(changes)
        .where(eq(changes.monitorId, monitor.id));
      await tx
        .update(notificationOutbox)
        .set({
          status: "failed",
          lastErrorCode: "MONITOR_DELETED",
          updatedAt: now,
        })
        .where(
          and(
            inArray(notificationOutbox.changeId, monitorChanges),
            eq(notificationOutbox.status, "pending"),
          ),
        );
      await tx
        .update(changes)
        .set({ notificationStatus: "failed" })
        .where(
          and(
            eq(changes.monitorId, monitor.id),
            eq(changes.notificationStatus, "pending"),
          ),
        );
      return monitor;
    });
    if (!deleted) {
      res.status(404).json({ error: "Monitor not found." });
      return;
    }
    res.status(204).end();
  }),
);

monitorRouter.post(
  "/monitors/:monitorId/check",
  requireAuth,
  requireCsrf,
  asyncRoute(async (req, res) => {
    const monitorId = resourceId(req, res, "monitorId");
    if (!monitorId) return;
    const [monitor] = await db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.id, monitorId),
          eq(monitors.userId, req.authUser!.id),
          ne(monitors.status, "deleted"),
        ),
      )
      .limit(1);
    if (!monitor) {
      res.status(404).json({ error: "Monitor not found." });
      return;
    }
    if (monitor.status !== "active") {
      res
        .status(409)
        .json({ error: "Resume this monitor before running a check." });
      return;
    }
    if (
      monitor.lastCheckedAt &&
      Date.now() - monitor.lastCheckedAt.getTime() < 60_000
    ) {
      res.status(429).json({
        error: "A check was completed recently. Try again in a minute.",
      });
      return;
    }

    const requestId = req.requestId ?? randomUUID();
    try {
      await enqueueManualMonitorCheck({
        monitorId: monitor.id,
        userId: req.authUser!.id,
        requestId,
        trigger: "manual",
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "MANUAL_CHECK_RATE_LIMIT"
      ) {
        res
          .status(429)
          .json({ error: error.message, code: "MANUAL_CHECK_RATE_LIMIT" });
        return;
      }
      throw error;
    }
    res.status(202).json({ queued: true, requestId });
  }),
);

monitorRouter.get(
  "/changes",
  requireAuth,
  asyncRoute(async (req, res) => {
    const rows = await db
      .select({
        id: changes.id,
        monitorId: changes.monitorId,
        monitorName: monitors.name,
        monitorUrl: monitors.url,
        detectedAt: changes.detectedAt,
        diff: changes.diff,
        notificationStatus: changes.notificationStatus,
      })
      .from(changes)
      .innerJoin(monitors, eq(changes.monitorId, monitors.id))
      .where(
        and(
          eq(monitors.userId, req.authUser!.id),
          ne(monitors.status, "deleted"),
        ),
      )
      .orderBy(desc(changes.detectedAt))
      .limit(200);
    res.setHeader("Cache-Control", "no-store");
    res.json({ changes: rows });
  }),
);

monitorRouter.get(
  "/changes/:changeId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const changeId = resourceId(req, res, "changeId");
    if (!changeId) return;
    const [row] = await db
      .select({ change: changes, monitor: monitors })
      .from(changes)
      .innerJoin(monitors, eq(changes.monitorId, monitors.id))
      .where(
        and(
          eq(changes.id, changeId),
          eq(monitors.userId, req.authUser!.id),
          ne(monitors.status, "deleted"),
        ),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Change not found." });
      return;
    }
    const snapshotIds = [
      row.change.previousSnapshotId,
      row.change.newSnapshotId,
    ].filter((id): id is string => Boolean(id));
    const history = snapshotIds.length
      ? await db
          .select()
          .from(snapshots)
          .where(inArray(snapshots.id, snapshotIds))
      : [];
    const previousSnapshot =
      history.find(
        (snapshot) => snapshot.id === row.change.previousSnapshotId,
      ) ?? null;
    const newSnapshot =
      history.find((snapshot) => snapshot.id === row.change.newSnapshotId) ??
      null;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...row, previousSnapshot, newSnapshot });
  }),
);

monitorRouter.get(
  "/settings/notifications",
  requireAuth,
  asyncRoute(async (req, res) => {
    const [preferences] = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, req.authUser!.id))
      .limit(1);
    res.json({
      preferences: preferences ?? {
        emailAlerts: true,
        weeklyDigest: false,
        failureAlerts: true,
      },
    });
  }),
);

monitorRouter.patch(
  "/settings/notifications",
  requireAuth,
  requireCsrf,
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({
        emailAlerts: z.boolean(),
        weeklyDigest: z.boolean(),
        failureAlerts: z.boolean(),
      })
      .partial()
      .strict()
      .safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
      res
        .status(400)
        .json({ error: "Provide at least one notification preference." });
      return;
    }
    const [updated] = await db
      .insert(notificationPreferences)
      .values({ userId: req.authUser!.id, ...parsed.data })
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: { ...parsed.data, updatedAt: new Date() },
      })
      .returning();
    res.json({ preferences: updated });
  }),
);

monitorRouter.get(
  "/usage",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.authUser!.id;
    const usage = await canAddMonitor(userId);
    const weekStart = new Date();
    weekStart.setUTCHours(0, 0, 0, 0);
    weekStart.setUTCDate(weekStart.getUTCDate() - 6);
    const day = sql`date_trunc('day', ${snapshots.fetchedAt} AT TIME ZONE 'UTC')`;
    const [weekly] = await db
      .select({ checks: count() })
      .from(snapshots)
      .innerJoin(monitors, eq(snapshots.monitorId, monitors.id))
      .where(
        and(
          eq(monitors.userId, userId),
          ne(monitors.status, "deleted"),
          gte(snapshots.fetchedAt, weekStart),
        ),
      );
    const dailyRows = await db
      .select({
        date: sql<string>`to_char(${day}, 'YYYY-MM-DD')`,
        checks: count(),
      })
      .from(snapshots)
      .innerJoin(monitors, eq(snapshots.monitorId, monitors.id))
      .where(
        and(
          eq(monitors.userId, userId),
          ne(monitors.status, "deleted"),
          gte(snapshots.fetchedAt, weekStart),
        ),
      )
      .groupBy(day)
      .orderBy(day);
    const dailyCounts = new Map(dailyRows.map((row) => [row.date, row.checks]));
    const checksByDay = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(weekStart.getTime() + index * 24 * 60 * 60 * 1_000)
        .toISOString()
        .slice(0, 10);
      return { date, checks: dailyCounts.get(date) ?? 0 };
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      plan: usage.plan,
      monitors: usage.current,
      limit: usage.limit,
      remaining: Math.max(0, usage.limit - usage.current),
      checksThisWeek: weekly?.checks ?? 0,
      checksByDay,
    });
  }),
);

function resourceId(req: Request, res: Response, key: string): string | null {
  const parsed = z.string().uuid().safeParse(req.params[key]);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid resource identifier." });
    return null;
  }
  return parsed.data;
}
