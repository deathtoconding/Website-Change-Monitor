import { ArrowUpRight, Bell, ChevronRight, Minus, Plus } from "lucide-react";
import { diffText, formatRelativeTime, getDomain } from "../lib/monitoring";
import type { Change, Monitor } from "../lib/types";
import { BrandMark } from "./BrandMark";

interface ChangeRowProps {
  change: Change;
  monitor: Monitor;
  onClick: () => void;
  compact?: boolean;
}

export function ChangeRow({
  change,
  monitor,
  onClick,
  compact = false,
}: ChangeRowProps) {
  const diff = change.diff?.length
    ? change.diff
    : diffText(change.previousText, change.newText);
  const added = diff.filter((line) => line.kind === "added");
  const removed = diff.filter((line) => line.kind === "removed");
  const total = added.length + removed.length;
  const preview = [...added, ...removed].slice(0, compact ? 1 : 2);

  return (
    <button
      className={`change-row ${compact ? "change-row-compact" : ""}`}
      type="button"
      onClick={onClick}
    >
      <span className="change-brand">
        <BrandMark url={monitor.url} />
      </span>
      <span className="change-main">
        <span className="change-title-line">
          <strong>{monitor.name}</strong>
          <span className="change-domain">{getDomain(monitor.url)}</span>
          <span className="change-row-time">
            {formatRelativeTime(change.detectedAt)}
          </span>
        </span>
        <span className="change-description">
          <span className="change-count-label">
            {total} {total === 1 ? "line" : "lines"} changed
          </span>
          <span className="change-separator">·</span>
          {preview.length > 0 ? (
            preview.map((line, index) => (
              <span
                key={`${line.kind}-${index}`}
                className={`change-snippet change-snippet-${line.kind}`}
              >
                {line.kind === "added" ? (
                  <Plus size={11} />
                ) : (
                  <Minus size={11} />
                )}
                <span>{line.text}</span>
              </span>
            ))
          ) : (
            <span className="change-snippet change-snippet-unchanged">
              Content updated
            </span>
          )}
          {total > preview.length && (
            <span className="more-changes">+{total - preview.length} more</span>
          )}
        </span>
      </span>
      <span
        className={`notification-indicator notification-${change.notificationStatus}`}
        title={notificationTitle(change.notificationStatus)}
      >
        <Bell size={13} />
      </span>
      <span className="change-open">
        <ArrowUpRight size={15} />
      </span>
      <ChevronRight className="change-chevron" size={16} />
    </button>
  );
}

function notificationTitle(status: Change["notificationStatus"]): string {
  if (status === "sent") return "Email notification sent";
  if (status === "pending") return "Email notification pending";
  if (status === "failed") return "Email notification failed";
  return "Email notifications are not configured";
}
