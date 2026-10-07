import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, closeDatabase } from "./index.js";
import { logger } from "../logger.js";

try {
  await migrate(db, {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
  logger.info({ status: "success" }, "Database migrations are up to date");
} catch (error) {
  logger.error(
    { errorCode: "MIGRATION_FAILED", err: error },
    "Database migration failed",
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
