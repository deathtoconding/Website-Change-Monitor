export interface MonitorFetchTarget {
  url: string;
  selector: string;
}

export interface MonitorFetchState extends MonitorFetchTarget {
  status: string;
}

/** Reject a fetch result if its monitor was paused, deleted, or reconfigured mid-request. */
export function canCommitMonitorFetch(
  candidate: MonitorFetchTarget,
  current: MonitorFetchState,
): boolean {
  return (
    current.status === "active" &&
    candidate.url === current.url &&
    candidate.selector === current.selector
  );
}
