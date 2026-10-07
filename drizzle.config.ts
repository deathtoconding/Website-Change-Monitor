import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { assertProductionDatabaseUrlConfigured } from "./src/server/config-validation.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl !== undefined && !databaseUrl.trim())
  throw new Error("DATABASE_URL must not be empty.");
assertProductionDatabaseUrlConfigured(
  process.env.NODE_ENV ?? "development",
  databaseUrl,
);

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl ?? "postgres://wcm:wcm@127.0.0.1:5432/wcm",
  },
  strict: true,
  verbose: true,
});
