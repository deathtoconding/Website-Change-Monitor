import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { buildExpiredSnapshotDeletionQuery } from "./snapshot-retention.js";

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 8 })
  : null;
const ownedUserIds = new Set<string>();

describe.skipIf(!pool)("PostgreSQL 16 persistence integration", () => {
  beforeAll(async () => {
    await pool!.query("SELECT 1");
  });

  afterAll(async () => {
    for (const userId of ownedUserIds)
      await pool!.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool!.end();
  });

  it("confirms the real Drizzle migration table is current", async () => {
    const result = await pool!.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"',
    );
    expect(result.rows[0]?.count).toBe("4");
  });

  it("persists snapshots and timestamps and enforces unique and foreign-key constraints", async () => {
    const userId = await createUser();
    const timestamp = new Date();
    const monitor = await pool!.query<{ id: string; created_at: Date }>(
      `INSERT INTO monitors (user_id, name, url, next_check_at)
       VALUES ($1, 'PG integration monitor', 'https://example.com/', $2)
       RETURNING id, created_at`,
      [userId, timestamp],
    );
    const monitorId = monitor.rows[0]!.id;
    const snapshot = await pool!.query<{
      id: string;
      fetched_at: Date;
      content: string;
    }>(
      `INSERT INTO snapshots
         (monitor_id, content, content_hash, http_status, content_type, response_time_ms, fetched_at)
       VALUES ($1, 'real PostgreSQL snapshot', 'pg-integration-hash', 200, 'text/html', 17, $2)
       RETURNING id, fetched_at, content`,
      [monitorId, timestamp],
    );
    await pool!.query(
      "UPDATE monitors SET current_snapshot_id = $1, current_hash = $2 WHERE id = $3",
      [snapshot.rows[0]!.id, "pg-integration-hash", monitorId],
    );

    const persisted = await pool!.query<{
      content: string;
      current_hash: string;
      fetched_at: Date;
      created_at: Date;
    }>(
      `SELECT s.content, m.current_hash, s.fetched_at, m.created_at
       FROM monitors m JOIN snapshots s ON s.monitor_id = m.id
       WHERE m.id = $1 AND s.id = $2`,
      [monitorId, snapshot.rows[0]!.id],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      content: "real PostgreSQL snapshot",
      current_hash: "pg-integration-hash",
    });
    expect(persisted.rows[0]!.fetched_at.toISOString()).toBe(
      timestamp.toISOString(),
    );
    expect(persisted.rows[0]!.created_at).toBeInstanceOf(Date);
    expect(snapshot.rows[0]!.content).toBe("real PostgreSQL snapshot");

    await expect(
      pool!.query(
        "INSERT INTO users (email, password_hash) VALUES ($1, 'hash')",
        [`pg-integration-${userId}@example.com`],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool!.query(
        `INSERT INTO monitors (user_id, name, url)
         VALUES ($1, 'orphan monitor', 'https://example.com/')`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool!.query(
        `INSERT INTO monitors (user_id, name, url, frequency)
         VALUES ($1, 'invalid enum', 'https://example.com/', 'weekly')`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "22P02" });
  });

  it("rolls back a failed multi-statement transaction atomically", async () => {
    const userId = randomUUID();
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')",
        [userId, `pg-rollback-${userId}@example.com`],
      );
      await expect(
        client.query(
          `INSERT INTO monitors (user_id, name, url, frequency)
           VALUES ($1, 'invalid frequency', 'https://example.com/', 'weekly')`,
          [userId],
        ),
      ).rejects.toMatchObject({ code: "22P02" });
      await client.query("ROLLBACK");

      const result = await pool!.query("SELECT id FROM users WHERE id = $1", [
        userId,
      ]);
      expect(result.rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it("serializes concurrent row updates with PostgreSQL row locks", async () => {
    const userId = await createUser();
    const monitor = await pool!.query<{ id: string }>(
      `INSERT INTO monitors (user_id, name, url, current_hash)
       VALUES ($1, 'concurrent monitor', 'https://example.com/', 'baseline')
       RETURNING id`,
      [userId],
    );
    const monitorId = monitor.rows[0]!.id;
    const first = await pool!.connect();
    const second = await pool!.connect();
    let secondLockFinished = false;
    try {
      await first.query("BEGIN");
      await first.query("SELECT id FROM monitors WHERE id = $1 FOR UPDATE", [
        monitorId,
      ]);
      await second.query("BEGIN");
      const secondLock = second
        .query<{ current_hash: string }>(
          "SELECT current_hash FROM monitors WHERE id = $1 FOR UPDATE",
          [monitorId],
        )
        .then((result) => {
          secondLockFinished = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(secondLockFinished).toBe(false);
      await first.query(
        "UPDATE monitors SET current_hash = 'writer-one' WHERE id = $1",
        [monitorId],
      );
      await first.query("COMMIT");

      const lockedRow = await secondLock;
      expect(lockedRow.rows[0]?.current_hash).toBe("writer-one");
      await second.query(
        "UPDATE monitors SET current_hash = 'writer-two' WHERE id = $1",
        [monitorId],
      );
      await second.query("COMMIT");
      const final = await pool!.query<{ current_hash: string }>(
        "SELECT current_hash FROM monitors WHERE id = $1",
        [monitorId],
      );
      expect(final.rows[0]?.current_hash).toBe("writer-two");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it("runs snapshot retention against PostgreSQL and preserves pending outbox references", async () => {
    const userId = await createUser();
    const monitor = await pool!.query<{ id: string }>(
      `INSERT INTO monitors (user_id, name, url)
       VALUES ($1, 'retention monitor', 'https://example.com/') RETURNING id`,
      [userId],
    );
    const monitorId = monitor.rows[0]!.id;
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1_000);
    const baseline = await insertSnapshot(
      monitorId,
      "expired baseline",
      expiredAt,
    );
    const pending = await insertSnapshot(
      monitorId,
      "pending notification snapshot",
      new Date(expiredAt.getTime() + 1_000),
    );
    await pool!.query(
      "UPDATE monitors SET current_snapshot_id = $1, current_hash = 'expired' WHERE id = $2",
      [baseline, monitorId],
    );
    const change = await pool!.query<{ id: string }>(
      `INSERT INTO changes (monitor_id, previous_snapshot_id, new_snapshot_id, diff)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [
        monitorId,
        baseline,
        pending,
        JSON.stringify([{ kind: "added", text: "new" }]),
      ],
    );
    await pool!.query(
      `INSERT INTO notification_outbox (change_id, user_id, recipient_email)
       VALUES ($1, $2, $3)`,
      [change.rows[0]!.id, userId, `pg-retention-${userId}@example.com`],
    );

    const firstPrune = await executeRetention(now);
    expect(new Set(firstPrune.rows.map((row) => row.id))).toEqual(
      new Set([baseline]),
    );
    const afterFirstPrune = await pool!.query<{
      current_snapshot_id: string | null;
      current_hash: string | null;
      pending_snapshot_exists: boolean;
    }>(
      `SELECT m.current_snapshot_id, m.current_hash,
              EXISTS(SELECT 1 FROM snapshots WHERE id = $2) AS pending_snapshot_exists
       FROM monitors m WHERE m.id = $1`,
      [monitorId, pending],
    );
    expect(afterFirstPrune.rows[0]).toMatchObject({
      current_snapshot_id: null,
      current_hash: null,
      pending_snapshot_exists: true,
    });

    await pool!.query(
      "UPDATE notification_outbox SET status = 'sent' WHERE change_id = $1",
      [change.rows[0]!.id],
    );
    const secondPrune = await executeRetention(now);
    expect(secondPrune.rows.map((row) => row.id)).toContain(pending);
  });
});

async function createUser(): Promise<string> {
  const userId = randomUUID();
  await pool!.query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'integration-hash')",
    [userId, `pg-integration-${userId}@example.com`],
  );
  ownedUserIds.add(userId);
  return userId;
}

async function insertSnapshot(
  monitorId: string,
  content: string,
  fetchedAt: Date,
): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    `INSERT INTO snapshots
       (monitor_id, content, content_hash, http_status, content_type, response_time_ms, fetched_at)
     VALUES ($1, $2, $3, 200, 'text/html', 10, $4) RETURNING id`,
    [monitorId, content, `hash-${randomUUID()}`, fetchedAt],
  );
  return result.rows[0]!.id;
}

async function executeRetention(now: Date) {
  const query = new PgDialect().sqlToQuery(
    buildExpiredSnapshotDeletionQuery(now),
  );
  return pool!.query<{ id: string }>(query.sql, query.params);
}
