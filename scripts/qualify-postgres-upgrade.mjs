import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL must target disposable PostgreSQL.");
if (process.env.QUALIFICATION_DISPOSABLE_DATABASE !== "true") {
  throw new Error(
    "Set QUALIFICATION_DISPOSABLE_DATABASE=true only for a disposable CI database.",
  );
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const migrationsFolder = path.join(repositoryRoot, "drizzle");
const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
const journal = JSON.parse(await readFile(journalPath, "utf8"));
if (journal.entries.length < 2)
  throw new Error("At least two migrations are required to qualify upgrades.");

const databaseName = `wcm_upgrade_${randomUUID().replaceAll("-", "")}`;
const upgradeUrl = new URL(databaseUrl);
upgradeUrl.pathname = `/${databaseName}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const upgradePool = new Pool({
  connectionString: upgradeUrl.toString(),
  max: 2,
});
const temporaryFolder = await mkdtemp(
  path.join(os.tmpdir(), "wcm-postgres-upgrade-"),
);
let databaseCreated = false;

try {
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;

  const preUpgradeFolder = path.join(temporaryFolder, "pre-upgrade");
  const metaFolder = path.join(preUpgradeFolder, "meta");
  await mkdir(metaFolder, { recursive: true });
  await writeFile(
    path.join(metaFolder, "_journal.json"),
    JSON.stringify(
      { ...journal, entries: journal.entries.slice(0, -1) },
      null,
      2,
    ),
  );
  for (const migration of journal.entries.slice(0, -1)) {
    await cp(
      path.join(migrationsFolder, `${migration.tag}.sql`),
      path.join(preUpgradeFolder, `${migration.tag}.sql`),
    );
  }

  const database = drizzle(upgradePool);
  await migrate(database, { migrationsFolder: preUpgradeFolder });
  const beforeUpgrade = await upgradePool.query(
    `SELECT to_regclass('public.system_notification_outbox') AS table_name`,
  );
  if (beforeUpgrade.rows[0]?.table_name)
    throw new Error(
      "The pre-upgrade schema unexpectedly contains the latest table.",
    );

  const legacyUserId = randomUUID();
  await upgradePool.query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'upgrade-qualification-hash')",
    [legacyUserId, `upgrade-${legacyUserId}@example.test`],
  );

  await migrate(database, { migrationsFolder });
  const afterUpgrade = await upgradePool.query(
    `SELECT to_regclass('public.system_notification_outbox') AS table_name,
            (SELECT count(*)::text FROM drizzle.__drizzle_migrations) AS migration_count,
            (SELECT count(*)::text FROM users WHERE id = $1) AS preserved_user_count`,
    [legacyUserId],
  );
  if (
    !afterUpgrade.rows[0]?.table_name ||
    afterUpgrade.rows[0].migration_count !== "4" ||
    afterUpgrade.rows[0].preserved_user_count !== "1"
  ) {
    throw new Error(
      "The upgrade did not apply the latest schema migration while preserving the existing row.",
    );
  }

  await migrate(database, { migrationsFolder });
  console.log(
    `PostgreSQL migration upgrade passed: prior ${journal.entries.length - 1} migrations upgraded to ${journal.entries.length}.`,
  );
} finally {
  await upgradePool.end().catch(() => undefined);
  if (databaseCreated) {
    await adminPool
      .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      .catch((error) => {
        console.error(
          `Could not remove disposable database ${databaseName}:`,
          error,
        );
      });
  }
  await adminPool.end();
  await rm(temporaryFolder, { recursive: true, force: true });
}
