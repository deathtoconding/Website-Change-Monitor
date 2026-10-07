import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import { env } from "../config.js";
import { logger } from "../logger.js";

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 20_000,
  application_name: "website-change-monitor",
});

pool.on("error", (error) => {
  logger.error(
    { errorCode: "DB_POOL_ERROR", err: error },
    "Unexpected idle database client error",
  );
});

export const db = drizzle(pool, { schema });

export async function pingDatabase(): Promise<void> {
  await pool.query("SELECT 1");
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
