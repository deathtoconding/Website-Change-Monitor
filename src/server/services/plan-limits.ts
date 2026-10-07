import { and, count, desc, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { monitors, subscriptions } from "../db/schema.js";

export const MONITOR_LIMITS: Record<Plan, number> = {
  free: 5,
  starter: 50,
  business: 250,
};

export type Plan = "free" | "starter" | "business";

export async function getEffectivePlan(userId: string): Promise<Plan> {
  const rows = await db
    .select({
      plan: subscriptions.plan,
      status: subscriptions.status,
      periodEnd: subscriptions.currentPeriodEnd,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .orderBy(desc(subscriptions.updatedAt));
  return resolveEffectivePlan(rows);
}

export function resolveEffectivePlan(
  rows: readonly { plan: Plan; status: string; periodEnd: Date | null }[],
  now = new Date(),
): Plan {
  const current = rows.find((row) => {
    if (row.status === "active" || row.status === "trialing") return true;
    if (row.status === "past_due") return !row.periodEnd || row.periodEnd > now;
    if (row.status === "canceled")
      return Boolean(row.periodEnd && row.periodEnd > now);
    return false;
  });
  return current?.plan ?? "free";
}

export async function countUserMonitors(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(monitors)
    .where(and(eq(monitors.userId, userId), ne(monitors.status, "deleted")));
  return row?.count ?? 0;
}

export async function canAddMonitor(
  userId: string,
): Promise<{ allowed: boolean; plan: Plan; limit: number; current: number }> {
  const plan = await getEffectivePlan(userId);
  const limit = MONITOR_LIMITS[plan];
  const current = await countUserMonitors(userId);
  return { allowed: current < limit, plan, limit, current };
}
