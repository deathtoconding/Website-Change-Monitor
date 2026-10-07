import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.js";
import { monitorOwnedAndNotDeleted } from "./monitor-conditions.js";

const monitorId = "00000000-0000-0000-0000-000000000001";
const ownerId = "00000000-0000-0000-0000-000000000002";
let client: PGlite | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("monitor write conditions", () => {
  it("does not reactivate a monitor after deletion has committed", async () => {
    client = new PGlite();
    await client.exec(`
      CREATE TABLE monitors (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        status text NOT NULL
      );
      INSERT INTO monitors (id, user_id, status)
      VALUES ('${monitorId}', '${ownerId}', 'deleted');
    `);
    const db = drizzle(client, { schema });

    const updated = await db
      .update(schema.monitors)
      .set({ status: "active" })
      .where(monitorOwnedAndNotDeleted(monitorId, ownerId))
      .returning({ id: schema.monitors.id });
    const rows = await client.query<{ status: string }>(
      "SELECT status FROM monitors WHERE id = $1",
      [monitorId],
    );

    expect(updated).toEqual([]);
    expect(rows.rows[0]?.status).toBe("deleted");
  }, 30_000);

  it("keeps ownership in the write predicate", async () => {
    client = new PGlite();
    await client.exec(`
      CREATE TABLE monitors (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        status text NOT NULL
      );
      INSERT INTO monitors (id, user_id, status)
      VALUES ('${monitorId}', '${ownerId}', 'paused');
    `);
    const db = drizzle(client, { schema });

    const updated = await db
      .update(schema.monitors)
      .set({ status: "active" })
      .where(
        monitorOwnedAndNotDeleted(
          monitorId,
          "00000000-0000-0000-0000-000000000003",
        ),
      )
      .returning({ id: schema.monitors.id });
    const rows = await client.query<{ status: string }>(
      "SELECT status FROM monitors WHERE id = $1",
      [monitorId],
    );

    expect(updated).toEqual([]);
    expect(rows.rows[0]?.status).toBe("paused");
  }, 30_000);
});
