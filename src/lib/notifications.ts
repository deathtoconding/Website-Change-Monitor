import type { DiffLine } from "./types.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const DIGEST_HOUR_UTC = 9;
export const PERSISTENT_FAILURE_THRESHOLD = 3;

export function shouldNotifyForPersistentFailure(
  failureCount: number,
  alertsEnabled: boolean,
): boolean {
  return alertsEnabled && failureCount >= PERSISTENT_FAILURE_THRESHOLD;
}

export interface WeeklyDigestPeriod {
  start: Date;
  end: Date;
}

/** Returns the most recently due Monday 09:00 UTC digest window, or null before that week's send time. */
export function getWeeklyDigestPeriod(now: Date): WeeklyDigestPeriod | null {
  const mondayOffset = (now.getUTCDay() + 6) % 7;
  const currentMondayAtNine = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - mondayOffset,
      DIGEST_HOUR_UTC,
    ),
  );

  if (now.getTime() < currentMondayAtNine.getTime()) return null;

  return {
    start: new Date(currentMondayAtNine.getTime() - WEEK_MS),
    end: currentMondayAtNine,
  };
}

export function weeklyDigestDedupeKey(userId: string, periodEnd: Date): string {
  return `weekly:${periodEnd.toISOString()}:${userId}`;
}

export function failureNotificationDedupeKey(
  monitorId: string,
  requestId: string,
): string {
  return `failure:${monitorId}:${requestId}`;
}

export function countDiffChanges(diff: DiffLine[]): {
  addedCount: number;
  removedCount: number;
} {
  return {
    addedCount: diff.filter((line) => line.kind === "added").length,
    removedCount: diff.filter((line) => line.kind === "removed").length,
  };
}
