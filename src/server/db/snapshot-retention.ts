import { sql } from "drizzle-orm";

export function buildExpiredSnapshotDeletionQuery(now: Date) {
  return sql`
    WITH doomed AS (
      SELECT s.id, s.monitor_id
      FROM snapshots s
      INNER JOIN monitors m ON m.id = s.monitor_id
      LEFT JOIN LATERAL (
        SELECT sub.plan
        FROM subscriptions sub
        WHERE sub.user_id = m.user_id
          AND (
            sub.status IN ('active', 'trialing')
            OR (sub.status = 'past_due' AND (sub.current_period_end IS NULL OR sub.current_period_end > ${now}::timestamptz))
            OR (sub.status = 'canceled' AND sub.current_period_end > ${now}::timestamptz)
          )
        ORDER BY sub.updated_at DESC
        LIMIT 1
      ) effective_plan ON true
      WHERE s.fetched_at < ${now}::timestamptz - (
        CASE COALESCE(effective_plan.plan::text, 'free')
          WHEN 'starter' THEN 30
          WHEN 'business' THEN 365
          ELSE 7
        END * INTERVAL '1 day'
      )
        AND NOT EXISTS (
          SELECT 1
          FROM changes c
          INNER JOIN notification_outbox o ON o.change_id = c.id
          WHERE c.new_snapshot_id = s.id AND o.status = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM changes c
          INNER JOIN system_notification_outbox o
            ON o.kind = 'weekly_digest'
           AND o.status = 'pending'
           AND o.payload->'changes' @> jsonb_build_array(
             jsonb_build_object('changeId', c.id::text)
           )
          WHERE c.new_snapshot_id = s.id
        )
      ORDER BY s.fetched_at
      LIMIT 1000
      FOR UPDATE OF s, m SKIP LOCKED
    ), cleared_current_baselines AS (
      UPDATE monitors m
      SET current_snapshot_id = NULL,
          current_hash = NULL,
          updated_at = ${now}::timestamptz
      FROM doomed
      WHERE m.id = doomed.monitor_id
        AND m.current_snapshot_id = doomed.id
      RETURNING m.id
    )
    DELETE FROM snapshots s USING doomed WHERE s.id = doomed.id
    RETURNING s.id
  `;
}
