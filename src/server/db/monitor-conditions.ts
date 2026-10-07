import { and, eq, ne } from "drizzle-orm";
import { monitors } from "./schema.js";

export function monitorOwnedAndNotDeleted(monitorId: string, userId: string) {
  return and(
    eq(monitors.id, monitorId),
    eq(monitors.userId, userId),
    ne(monitors.status, "deleted"),
  );
}
