import {
  Activity,
  ArrowUpRight,
  Bell,
  CircleHelp,
  LayoutDashboard,
  Plus,
  ScanEye,
  Settings2,
  X,
  LogOut,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Monitor } from "../lib/types";
import { BrandMark } from "./BrandMark";

export type AppView =
  "overview" | "monitors" | "changes" | "settings" | "detail";
export type PlanName = "free" | "starter" | "business";

interface SidebarProps {
  activeView: AppView;
  monitors: Monitor[];
  mobileOpen: boolean;
  userEmail: string;
  plan: PlanName;
  monitorLimit: number;
  onNavigate: (view: AppView) => void;
  onAddMonitor: () => void;
  onOpenMonitor: (monitorId: string) => void;
  onCloseMobile: () => void;
  onLogout: () => void;
}

const NAV_ITEMS: {
  view: AppView;
  label: string;
  icon: typeof LayoutDashboard;
}[] = [
  { view: "overview", label: "Overview", icon: LayoutDashboard },
  { view: "monitors", label: "Monitors", icon: ScanEye },
  { view: "changes", label: "Change history", icon: Activity },
  { view: "settings", label: "Settings", icon: Settings2 },
];

function initials(email: string): string {
  return email.split("@")[0].slice(0, 2).toUpperCase() || "U";
}

export function Sidebar({
  activeView,
  monitors,
  mobileOpen,
  userEmail,
  plan,
  monitorLimit,
  onNavigate,
  onAddMonitor,
  onOpenMonitor,
  onCloseMobile,
  onLogout,
}: SidebarProps) {
  const monitorCount = monitors.length;
  const progress =
    monitorLimit > 0 ? Math.min(100, (monitorCount / monitorLimit) * 100) : 0;
  const navigate = (view: AppView) => {
    onNavigate(view);
    onCloseMobile();
  };

  const content = (
    <>
      <div className="sidebar-brand-row">
        <a
          className="product-brand"
          href="#overview"
          onClick={(event) => {
            event.preventDefault();
            navigate("overview");
          }}
        >
          <span className="product-logo">
            <BrandMark />
          </span>
          <span className="product-name">
            watchtower<span className="product-dot">.</span>
          </span>
        </a>
        <button
          className="icon-button sidebar-close"
          type="button"
          aria-label="Close navigation"
          onClick={onCloseMobile}
        >
          <X size={18} />
        </button>
      </div>

      <button
        className="workspace-switcher"
        type="button"
        onClick={() => navigate("settings")}
      >
        <span className="workspace-avatar">{initials(userEmail)}</span>
        <span className="workspace-copy">
          <strong>Personal workspace</strong>
          <span>{userEmail}</span>
        </span>
        <span className="workspace-chevron">⌄</span>
      </button>

      <div className="sidebar-label">WORKSPACE</div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {NAV_ITEMS.map(({ view, label, icon: Icon }) => {
          const isActive =
            activeView === view ||
            (activeView === "detail" && view === "monitors");
          const count = view === "monitors" ? monitors.length : undefined;
          return (
            <button
              type="button"
              key={view}
              className={`nav-link ${isActive ? "is-active" : ""}`}
              onClick={() => navigate(view)}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon size={17} strokeWidth={isActive ? 2.2 : 1.8} />
              <span>{label}</span>
              {count !== undefined && (
                <span className="nav-count">{count}</span>
              )}
              {view === "overview" && <span className="nav-active-dot" />}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-divider" />
      <div className="sidebar-label sidebar-label-row">
        <span>QUICK ACCESS</span>
        <button
          className="tiny-icon-button"
          type="button"
          aria-label="Add a monitor"
          onClick={onAddMonitor}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="quick-access-list">
        {monitors.slice(0, 4).map((monitor) => (
          <button
            className="quick-access-link"
            type="button"
            key={monitor.id}
            onClick={() => {
              onOpenMonitor(monitor.id);
              onCloseMobile();
            }}
          >
            <BrandMark url={monitor.url} size="small" />
            <span>{monitor.name}</span>
            <span className={`quick-status quick-status-${monitor.status}`} />
          </button>
        ))}
        {monitors.length === 0 && (
          <p className="sidebar-empty">Your monitors will show up here.</p>
        )}
      </div>

      <div className="sidebar-spacer" />
      <div className="plan-card">
        <div className="plan-card-top">
          <span className="plan-icon">
            <Activity size={14} />
          </span>
          <span>{plan.charAt(0).toUpperCase() + plan.slice(1)} plan</span>
          <span className="plan-arrow">
            <ArrowUpRight size={13} />
          </span>
        </div>
        <div className="plan-card-caption">
          {monitorCount} of {monitorLimit} monitor slots used
        </div>
        <div className="plan-progress">
          <span style={{ width: `${progress}%` }} />
        </div>
        <button
          type="button"
          className="plan-upgrade"
          onClick={() => navigate("settings")}
        >
          {plan === "business" ? "Manage plan" : "Explore plans"}{" "}
          <ArrowUpRight size={13} />
        </button>
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-footer-link"
          onClick={() => navigate("settings")}
        >
          <CircleHelp size={16} /> Help & settings
        </button>
        <div className="user-profile">
          <div className="user-avatar">{initials(userEmail)}</div>
          <div className="user-copy">
            <strong>{userEmail}</strong>
            <span>Signed in</span>
          </div>
          <button
            type="button"
            className="tiny-icon-button user-more"
            aria-label="Sign out"
            title="Sign out"
            onClick={onLogout}
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          type="button"
          onClick={onCloseMobile}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? "sidebar-mobile-open" : ""}`}>
        {content}
      </aside>
    </>
  );
}

export function TopBar({
  children,
  onMenu,
  onSearch,
  onHelp,
  onNotifications,
  searchValue,
  userEmail,
}: {
  children?: ReactNode;
  onMenu: () => void;
  onSearch: (value: string) => void;
  onHelp: () => void;
  onNotifications: () => void;
  searchValue: string;
  userEmail: string;
}) {
  return (
    <header className="topbar">
      <button
        className="icon-button mobile-menu-button"
        type="button"
        aria-label="Open navigation"
        onClick={onMenu}
      >
        <span className="menu-lines">
          <i />
          <i />
          <i />
        </span>
      </button>
      <div className="topbar-search">
        <ScanEye size={16} className="topbar-search-icon" />
        <input
          aria-label="Search monitors"
          placeholder="Search monitors..."
          value={searchValue}
          onChange={(event) => onSearch(event.target.value)}
        />
        <kbd>⌘ K</kbd>
      </div>
      <div className="topbar-right">
        <span className="demo-pill">
          <span /> Live monitoring
        </span>
        <button
          className="icon-button topbar-help"
          type="button"
          aria-label="Help and settings"
          title="Help and settings"
          onClick={onHelp}
        >
          <CircleHelp size={17} />
        </button>
        <button
          className="icon-button notification-button"
          type="button"
          aria-label="Change history"
          title="Change history"
          onClick={onNotifications}
        >
          <Bell size={17} />
        </button>
        <div className="topbar-avatar" aria-label={userEmail}>
          {initials(userEmail)}
        </div>
      </div>
      {children}
    </header>
  );
}
