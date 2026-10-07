import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildExpiredSnapshotDeletionQuery } from "./snapshot-retention.js";

const now = new Date("2026-10-07T12:00:00.000Z");
const monitorIds = {
  free: "00000000-0000-0000-0000-000000000001",
  starter: "00000000-0000-0000-0000-000000000002",
  business: "00000000-0000-0000-0000-000000000003",
  pendingAlert: "00000000-0000-0000-0000-000000000004",
  pendingDigest: "00000000-0000-0000-0000-000000000005",
};
const snapshotIds = {
  freeCurrent: "10000000-0000-0000-0000-000000000001",
  starterRetained: "10000000-0000-0000-0000-000000000002",
  starterExpired: "10000000-0000-0000-0000-000000000003",
  businessRetained: "10000000-0000-0000-0000-000000000004",
  businessExpired: "10000000-0000-0000-0000-000000000005",
  pendingAlert: "10000000-0000-0000-0000-000000000006",
  pendingDigest: "10000000-0000-0000-0000-000000000007",
};
const changeIds = {
  pendingAlert: "20000000-0000-0000-0000-000000000001",
  pendingDigest: "20000000-0000-0000-0000-000000000002",
};

async function executePrune(client: PGlite) {
  const query = new PgDialect().sqlToQuery(
    buildExpiredSnapshotDeletionQuery(now),
  );
  return client.query<{ id: string }>(query.sql, query.params);
}

describe("expired snapshot retention SQL", () => {
  it("enforces plan windows, clears expired baselines, and protects pending email references", async () => {
    const client = new PGlite();
    try {
      await client.exec(`
        CREATE TABLE monitors (
          id uuid PRIMARY KEY,
          user_id uuid NOT NULL,
          current_snapshot_id uuid,
          current_hash text,
          updated_at timestamptz NOT NULL
        );
        CREATE TABLE snapshots (
          id uuid PRIMARY KEY,
          monitor_id uuid NOT NULL,
          fetched_at timestamptz NOT NULL
        );
        CREATE TABLE subscriptions (
          user_id uuid NOT NULL,
          plan text NOT NULL,
          status text NOT NULL,
          current_period_end timestamptz,
          updated_at timestamptz NOT NULL
        );
        CREATE TABLE changes (id uuid PRIMARY KEY, new_snapshot_id uuid NOT NULL);
        CREATE TABLE notification_outbox (change_id uuid NOT NULL, status text NOT NULL);
        CREATE TABLE system_notification_outbox (
          kind text NOT NULL,
          status text NOT NULL,
          payload jsonb NOT NULL
        );
      `);

      for (const monitorId of Object.values(monitorIds)) {
        await client.query(
          `INSERT INTO monitors (id, user_id, updated_at) VALUES ($1, $1, $2)`,
          [monitorId, now],
        );
      }
      await client.query(
        `UPDATE monitors SET current_snapshot_id = $1, current_hash = 'baseline' WHERE id = $2`,
        [snapshotIds.freeCurrent, monitorIds.free],
      );
      await client.query(
        `INSERT INTO subscriptions (user_id, plan, status, updated_at)
         VALUES ($1, 'starter', 'active', $3), ($2, 'business', 'active', $3)`,
        [monitorIds.starter, monitorIds.business, now],
      );

      const snapshotRows = [
        [snapshotIds.freeCurrent, monitorIds.free, "2026-09-28T00:00:00Z"],
        [
          snapshotIds.starterRetained,
          monitorIds.starter,
          "2026-09-10T00:00:00Z",
        ],
        [
          snapshotIds.starterExpired,
          monitorIds.starter,
          "2026-09-05T00:00:00Z",
        ],
        [
          snapshotIds.businessRetained,
          monitorIds.business,
          "2025-10-07T12:00:00Z",
        ],
        [
          snapshotIds.businessExpired,
          monitorIds.business,
          "2025-10-06T12:00:00Z",
        ],
        [
          snapshotIds.pendingAlert,
          monitorIds.pendingAlert,
          "2026-09-27T00:00:00Z",
        ],
        [
          snapshotIds.pendingDigest,
          monitorIds.pendingDigest,
          "2026-09-27T00:00:00Z",
        ],
      ];
      for (const [id, monitorId, fetchedAt] of snapshotRows) {
        await client.query(
          `INSERT INTO snapshots (id, monitor_id, fetched_at) VALUES ($1, $2, $3)`,
          [id, monitorId, new Date(fetchedAt)],
        );
      }
      await client.query(
        `INSERT INTO changes (id, new_snapshot_id) VALUES ($1, $3), ($2, $4)`,
        [
          changeIds.pendingAlert,
          changeIds.pendingDigest,
          snapshotIds.pendingAlert,
          snapshotIds.pendingDigest,
        ],
      );
      await client.query(
        `INSERT INTO notification_outbox (change_id, status) VALUES ($1, 'pending')`,
        [changeIds.pendingAlert],
      );
      await client.query(
        `INSERT INTO system_notification_outbox (kind, status, payload)
         VALUES ('weekly_digest', 'pending', $1::jsonb)`,
        [JSON.stringify({ changes: [{ changeId: changeIds.pendingDigest }] })],
      );

      const firstPrune = await executePrune(client);
      expect(new Set(firstPrune.rows.map((row) => row.id))).toEqual(
        new Set([
          snapshotIds.freeCurrent,
          snapshotIds.starterExpired,
          snapshotIds.businessExpired,
        ]),
      );
      const baseline = await client.query<{
        current_snapshot_id: string | null;
        current_hash: string | null;
      }>(
        `SELECT current_snapshot_id, current_hash FROM monitors WHERE id = $1`,
        [monitorIds.free],
      );
      expect(baseline.rows[0]).toEqual({
        current_snapshot_id: null,
        current_hash: null,
      });

      await client.exec(`
        UPDATE notification_outbox SET status = 'sent';
        UPDATE system_notification_outbox SET status = 'sent';
      `);
      const afterDelivery = await executePrune(client);
      expect(new Set(afterDelivery.rows.map((row) => row.id))).toEqual(
        new Set([snapshotIds.pendingAlert, snapshotIds.pendingDigest]),
      );
    } finally {
      await client.close();
    }
  }, 30_000);
});
