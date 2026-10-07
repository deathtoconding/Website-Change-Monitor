import { AlertTriangle, Check, Pause, Radio } from "lucide-react";
import type { MonitorStatus } from "../lib/types";

const LABELS: Record<MonitorStatus, string> = {
  active: "Active",
  paused: "Paused",
  error: "Needs attention",
};

export function StatusPill({ status }: { status: MonitorStatus }) {
  const Icon =
    status === "active" ? Check : status === "paused" ? Pause : AlertTriangle;
  return (
    <span className={`status-pill status-${status}`}>
      <Icon size={12} strokeWidth={2.4} />
      {LABELS[status]}
    </span>
  );
}

export function BaselinePill({ established }: { established: boolean }) {
  return established ? (
    <span className="baseline-pill">
      <Radio size={12} /> Baseline saved
    </span>
  ) : (
    <span className="baseline-pill baseline-waiting">
      <span className="pulse-dot" /> Waiting for snapshot
    </span>
  );
}
