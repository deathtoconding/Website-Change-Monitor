export function shouldRequeueStaleFailedMonitorJob(
  state: string,
  finishedOn: number | undefined,
  now: number,
  staleAfterMs: number,
): boolean {
  if (state !== "failed" || finishedOn === undefined) return false;
  if (
    !Number.isFinite(finishedOn) ||
    !Number.isFinite(now) ||
    !Number.isFinite(staleAfterMs) ||
    staleAfterMs <= 0
  )
    return false;
  return now - finishedOn >= staleAfterMs;
}
