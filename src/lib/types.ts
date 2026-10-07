export type Frequency = "hourly" | "six-hourly" | "daily";
export type MonitorStatus = "active" | "paused" | "error";
export type DiffKind = "added" | "removed" | "unchanged";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface Monitor {
  id: string;
  name: string;
  url: string;
  frequency: Frequency;
  status: MonitorStatus;
  selector: string;
  createdAt: string;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  nextCheckAt: string | null;
  consecutiveFailures: number;
  baselineEstablished: boolean;
  currentText: string;
  checkCount: number;
}

export interface Change {
  id: string;
  monitorId: string;
  detectedAt: string;
  previousText: string;
  newText: string;
  diff?: DiffLine[];
  notificationStatus: "sent" | "pending" | "failed" | "not-configured";
}

export interface NotificationSettings {
  emailAlerts: boolean;
  weeklyDigest: boolean;
  failureAlerts: boolean;
}

export interface WorkspaceState {
  monitors: Monitor[];
  changes: Change[];
  notifications: NotificationSettings;
}
