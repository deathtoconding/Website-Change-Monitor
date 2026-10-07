import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import {
  countDiffChanges,
  getWeeklyDigestPeriod,
  weeklyDigestDedupeKey,
} from "../../lib/notifications.js";
import type { DiffLine } from "../../lib/types.js";
import { db } from "../db/index.js";
import {
  changes,
  monitors,
  notificationPreferences,
  systemNotificationOutbox,
  users,
} from "../db/schema.js";

const MAX_DIGEST_RECIPIENTS_PER_TICK = 250;
const MAX_DIGEST_CHANGES_PER_USER = 50;

export async function queueWeeklyDigests(now: Date): Promise<number> {
  const period = getWeeklyDigestPeriod(now);
  if (!period) return 0;

  const periodEnd = period.end.toISOString();
  const duplicateForUser = db
    .select({ id: systemNotificationOutbox.id })
    .from(systemNotificationOutbox)
    .where(
      and(
        eq(systemNotificationOutbox.userId, users.id),
        eq(
          systemNotificationOutbox.dedupeKey,
          sql<string>`'weekly:' || ${periodEnd} || ':' || ${users.id}::text`,
        ),
      ),
    )
    .limit(1);

  const recipients = await db
    .select({ userId: users.id, email: users.email })
    .from(users)
    .innerJoin(
      notificationPreferences,
      eq(notificationPreferences.userId, users.id),
    )
    .where(
      and(
        eq(notificationPreferences.weeklyDigest, true),
        isNotNull(users.emailVerifiedAt),
        notExists(duplicateForUser),
      ),
    )
    .orderBy(asc(users.createdAt))
    .limit(MAX_DIGEST_RECIPIENTS_PER_TICK);

  if (recipients.length === 0) return 0;

  const recipientIds = recipients.map((recipient) => recipient.userId);
  const rankedChanges = db
    .select({
      userId: monitors.userId,
      changeId: changes.id,
      monitorName: monitors.name,
      url: monitors.url,
      detectedAt: changes.detectedAt,
      diff: changes.diff,
      changeRank:
        sql<number>`row_number() over (partition by ${monitors.userId} order by ${changes.detectedAt} desc, ${changes.id} desc)`.as(
          "change_rank",
        ),
    })
    .from(changes)
    .innerJoin(monitors, eq(changes.monitorId, monitors.id))
    .where(
      and(
        inArray(monitors.userId, recipientIds),
        ne(monitors.status, "deleted"),
        gte(changes.detectedAt, period.start),
        lt(changes.detectedAt, period.end),
      ),
    )
    .as("ranked_weekly_changes");

  const digestRows = await db
    .select({
      userId: rankedChanges.userId,
      changeId: rankedChanges.changeId,
      monitorName: rankedChanges.monitorName,
      url: rankedChanges.url,
      detectedAt: rankedChanges.detectedAt,
      diff: rankedChanges.diff,
    })
    .from(rankedChanges)
    .where(lte(rankedChanges.changeRank, MAX_DIGEST_CHANGES_PER_USER))
    .orderBy(desc(rankedChanges.detectedAt));

  const changesByUser = new Map<
    string,
    {
      changeId: string;
      monitorName: string;
      url: string;
      detectedAt: Date;
      diff: DiffLine[];
    }[]
  >();
  for (const change of digestRows) {
    const userChanges = changesByUser.get(change.userId) ?? [];
    userChanges.push(change);
    changesByUser.set(change.userId, userChanges);
  }

  const outboxRows = recipients.map((recipient) => {
    const userChanges = changesByUser.get(recipient.userId) ?? [];
    return {
      userId: recipient.userId,
      kind: "weekly_digest" as const,
      dedupeKey: weeklyDigestDedupeKey(recipient.userId, period.end),
      recipientEmail: recipient.email,
      payload: {
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        changes: userChanges.map((change) => ({
          changeId: change.changeId,
          monitorName: change.monitorName,
          url: change.url,
          detectedAt: change.detectedAt.toISOString(),
          ...countDiffChanges(change.diff),
        })),
      },
      status:
        userChanges.length > 0 ? ("pending" as const) : ("skipped" as const),
    };
  });

  await db
    .insert(systemNotificationOutbox)
    .values(outboxRows)
    .onConflictDoNothing({ target: systemNotificationOutbox.dedupeKey });

  return outboxRows.length;
}
