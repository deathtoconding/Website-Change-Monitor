import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { CSSProperties } from "react";

const POINTS = [22, 31, 26, 42, 37, 46, 40, 58, 49, 62, 57, 78, 70, 86, 77, 94];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function ActivityChart({ changeCount }: { changeCount: number }) {
  const width = 640;
  const height = 176;
  const paddingX = 14;
  const paddingY = 12;
  const usableHeight = height - paddingY * 2;
  const usableWidth = width - paddingX * 2;
  const coords = POINTS.map((value, index) => ({
    x: paddingX + (index / (POINTS.length - 1)) * usableWidth,
    y: height - paddingY - (value / 100) * usableHeight,
  }));
  const linePath = coords
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const lastPoint = coords[coords.length - 1];
  const areaPath = `${linePath} L ${lastPoint.x} ${height} L ${coords[0].x} ${height} Z`;

  return (
    <section className="surface chart-card">
      <div className="card-heading chart-card-heading">
        <div>
          <div className="eyebrow">MONITORING ACTIVITY</div>
          <h2>Everything, at a glance</h2>
        </div>
        <span className="icon-button more-button" aria-hidden="true">
          ···
        </span>
      </div>
      <div className="chart-summary">
        <span className="chart-total">{changeCount + 126}</span>
        <span className="chart-label">checks this week</span>
        <span className="trend-pill">
          <ArrowUpRight size={13} /> 12.8%
        </span>
        <span className="chart-compare">vs. last week</span>
      </div>
      <div className="activity-chart-wrap">
        <div className="chart-y-labels">
          <span>120</span>
          <span>90</span>
          <span>60</span>
          <span>30</span>
          <span>0</span>
        </div>
        <div className="chart-plot">
          <div className="chart-gridlines">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <svg
            className="activity-chart"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Monitoring checks trending up over the last seven days"
          >
            <defs>
              <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#4eaf86" stopOpacity=".21" />
                <stop offset="100%" stopColor="#4eaf86" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={areaPath} fill="url(#chart-fill)" />
            <path
              d={linePath}
              fill="none"
              stroke="#29966d"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {coords
              .filter((_, index) => [0, 3, 6, 9, 12, 15].includes(index))
              .map((point) => (
                <circle
                  key={point.x}
                  cx={point.x}
                  cy={point.y}
                  r="3.5"
                  fill="#fff"
                  stroke="#29966d"
                  strokeWidth="2"
                />
              ))}
            <circle
              cx={lastPoint.x}
              cy={lastPoint.y}
              r="6"
              fill="#29966d"
              stroke="#fff"
              strokeWidth="3"
            />
          </svg>
          <div className="chart-x-labels">
            {DAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="chart-footer">
        <span>
          <i className="legend-dot" /> Scheduled checks
        </span>
        <span>
          <ArrowDownRight size={14} /> Quiet hours included
        </span>
      </div>
    </section>
  );
}

export function HealthCard({
  activeCount,
  totalCount,
  healthPercent,
  errorCount,
  pausedCount,
}: {
  activeCount: number;
  totalCount: number;
  healthPercent: number;
  errorCount: number;
  pausedCount: number;
}) {
  const statusCopy =
    errorCount > 0
      ? `${errorCount} ${errorCount === 1 ? "monitor needs" : "monitors need"} attention`
      : "Everything is up to date.";
  return (
    <section className="surface health-card">
      <div className="card-heading">
        <div>
          <div className="eyebrow">WORKSPACE HEALTH</div>
          <h2>{errorCount > 0 ? "A quick look needed" : "All systems calm"}</h2>
        </div>
        <span className="health-spark">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="health-content">
        <div
          className="health-ring"
          style={{ "--health-percent": `${healthPercent}%` } as CSSProperties}
        >
          <div>
            <strong>{healthPercent}%</strong>
            <span>healthy</span>
          </div>
        </div>
        <div className="health-copy">
          <div className="health-copy-line">
            <span className="health-green-dot" />{" "}
            <strong>{activeCount} monitors</strong> are active
          </div>
          <p>
            {totalCount === 0 ? "Add a page to begin monitoring." : statusCopy}
          </p>
        </div>
      </div>
      <div className="health-card-footer">
        <span className="health-live-dot" /> Check status{" "}
        <span className="health-status-text">
          {errorCount > 0
            ? `${errorCount} issue${errorCount > 1 ? "s" : ""}`
            : pausedCount > 0
              ? `${pausedCount} paused`
              : "Looking good"}
        </span>
      </div>
    </section>
  );
}
