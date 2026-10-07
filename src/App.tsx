import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  Filter,
  Globe2,
  HeartPulse,
  Link2,
  ListChecks,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { BrandMark } from "./components/BrandMark";
import { ChangeRow } from "./components/ChangeRow";
import {
  MonitorDialog,
  type MonitorFormValues,
} from "./components/MonitorDialog";
import {
  Sidebar,
  TopBar,
  type AppView,
  type PlanName,
} from "./components/Sidebar";
import { BaselinePill, StatusPill } from "./components/StatusPill";
import { apiRequest, ApiError, clearCsrfToken, saveCsrfToken } from "./lib/api";
import {
  diffText,
  formatDateTime,
  formatRelativeTime,
  FREQUENCY_LABELS,
  getDomain,
} from "./lib/monitoring";
import type {
  Change,
  DiffLine,
  Monitor,
  NotificationSettings,
} from "./lib/types";

interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

interface MonitorRecord extends Omit<
  Monitor,
  "baselineEstablished" | "currentText" | "checkCount"
> {
  currentHash?: string | null;
  currentSnapshotId?: string | null;
  lastErrorCode?: string | null;
  checkCount?: number;
}

interface ChangeRecord extends Omit<
  Change,
  "previousText" | "newText" | "diff" | "notificationStatus"
> {
  diff: DiffLine[];
  notificationStatus: "pending" | "sent" | "failed" | "not_configured";
}

interface Usage {
  plan: PlanName;
  monitors: number;
  limit: number;
  remaining: number;
  checksThisWeek: number;
  checksByDay: { date: string; checks: number }[];
}

const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  emailAlerts: true,
  weeklyDigest: false,
  failureAlerts: true,
};

function mapMonitor(row: MonitorRecord, previous?: Monitor): Monitor {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    frequency: row.frequency,
    status: row.status,
    selector: row.selector,
    createdAt: row.createdAt,
    lastCheckedAt: row.lastCheckedAt,
    lastChangedAt: row.lastChangedAt,
    nextCheckAt: row.nextCheckAt,
    consecutiveFailures: row.consecutiveFailures,
    baselineEstablished: Boolean(row.currentSnapshotId),
    currentText: previous?.currentText ?? "",
    checkCount: row.checkCount ?? previous?.checkCount ?? 0,
  };
}

function mapChange(row: ChangeRecord): Change {
  const diff = Array.isArray(row.diff) ? row.diff : [];
  return {
    id: row.id,
    monitorId: row.monitorId,
    detectedAt: row.detectedAt,
    previousText: diff
      .filter((line) => line.kind !== "added")
      .map((line) => line.text)
      .join("\n"),
    newText: diff
      .filter((line) => line.kind !== "removed")
      .map((line) => line.text)
      .join("\n"),
    diff,
    notificationStatus:
      row.notificationStatus === "not_configured"
        ? "not-configured"
        : row.notificationStatus,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

function initials(email: string): string {
  return email.split("@")[0].slice(0, 2).toUpperCase() || "U";
}

function displayPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${getDomain(url)}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function formatLongDate(date = new Date()): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [view, setView] = useState<AppView>(() =>
    window.location.pathname === "/settings" ? "settings" : "overview",
  );
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [notifications, setNotifications] = useState<NotificationSettings>(
    DEFAULT_NOTIFICATIONS,
  );
  const [usage, setUsage] = useState<Usage>({
    plan: "free",
    monitors: 0,
    limit: 5,
    remaining: 5,
    checksThisWeek: 0,
    checksByDay: [],
  });
  const [selectedMonitorId, setSelectedMonitorId] = useState<string | null>(
    null,
  );
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMonitor, setEditingMonitor] = useState<Monitor | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [devVerificationToken, setDevVerificationToken] = useState<
    string | null
  >(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);

  const refreshWorkspace = useCallback(async () => {
    setWorkspaceLoading(true);
    setWorkspaceError("");
    try {
      const [
        monitorResponse,
        changeResponse,
        preferencesResponse,
        usageResponse,
      ] = await Promise.all([
        apiRequest<{ monitors: MonitorRecord[] }>("/api/monitors"),
        apiRequest<{ changes: ChangeRecord[] }>("/api/changes"),
        apiRequest<{ preferences: NotificationSettings }>(
          "/api/settings/notifications",
        ),
        apiRequest<Usage>("/api/usage"),
      ]);
      setMonitors((current) =>
        monitorResponse.monitors.map((row) =>
          mapMonitor(
            row,
            current.find((item) => item.id === row.id),
          ),
        ),
      );
      setChanges(changeResponse.changes.map(mapChange));
      setNotifications(
        preferencesResponse.preferences ?? DEFAULT_NOTIFICATIONS,
      );
      setUsage(usageResponse);

      const requestedChangeId = new URLSearchParams(window.location.search).get(
        "change",
      );
      if (requestedChangeId) {
        try {
          const linked = await apiRequest<{
            change: ChangeRecord;
            monitor: MonitorRecord;
            newSnapshot: { content: string } | null;
          }>(`/api/changes/${encodeURIComponent(requestedChangeId)}`);
          const linkedMonitor = {
            ...mapMonitor(
              linked.monitor,
              monitorResponse.monitors
                .map((row) => mapMonitor(row))
                .find((row) => row.id === linked.monitor.id),
            ),
            currentText: linked.newSnapshot?.content ?? "",
          };
          const linkedChange = mapChange(linked.change);
          setMonitors((current) =>
            current.some((item) => item.id === linkedMonitor.id)
              ? current.map((item) =>
                  item.id === linkedMonitor.id ? linkedMonitor : item,
                )
              : [linkedMonitor, ...current],
          );
          setChanges((current) => [
            linkedChange,
            ...current.filter((item) => item.id !== linkedChange.id),
          ]);
          setSelectedMonitorId(linkedMonitor.id);
          setSelectedChangeId(linkedChange.id);
          setView("detail");
        } catch {
          // A stale or inaccessible deep link should not prevent the rest of the workspace from loading.
        }
      } else {
        const requestedMonitorId = new URLSearchParams(
          window.location.search,
        ).get("monitor");
        if (requestedMonitorId) {
          try {
            const linked = await apiRequest<{
              monitor: MonitorRecord;
              currentSnapshot: { content: string } | null;
            }>(`/api/monitors/${encodeURIComponent(requestedMonitorId)}`);
            const linkedMonitor = {
              ...mapMonitor(
                linked.monitor,
                monitorResponse.monitors
                  .map((row) => mapMonitor(row))
                  .find((row) => row.id === linked.monitor.id),
              ),
              currentText: linked.currentSnapshot?.content ?? "",
            };
            setMonitors((current) =>
              current.some((item) => item.id === linkedMonitor.id)
                ? current.map((item) =>
                    item.id === linkedMonitor.id ? linkedMonitor : item,
                  )
                : [linkedMonitor, ...current],
            );
            setSelectedMonitorId(linkedMonitor.id);
            setSelectedChangeId(null);
            setView("detail");
          } catch {
            // A stale or inaccessible deep link should not prevent the rest of the workspace from loading.
          }
        }
      }
    } catch (error) {
      setWorkspaceError(getErrorMessage(error));
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.code === "EMAIL_NOT_VERIFIED")
      )
        setUser(null);
      throw error;
    } finally {
      setWorkspaceLoading(false);
    }
  }, []);

  const refreshSession = useCallback(async (): Promise<SessionUser> => {
    const response = await apiRequest<{ user: SessionUser }>("/api/auth/me");
    setUser(response.user);
    if (response.user.emailVerified) await refreshWorkspace();
    return response.user;
  }, [refreshWorkspace]);

  useEffect(() => {
    void (async () => {
      try {
        await refreshSession();
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401))
          setWorkspaceError(getErrorMessage(error));
        setUser(null);
      } finally {
        setBootstrapping(false);
      }
    })();
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, [refreshSession]);

  useEffect(() => {
    const updateClock = () => setCurrentTime(Date.now());
    updateClock();
    const timer = window.setInterval(updateClock, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3_600);
  }

  async function handleSignedIn(nextUser: SessionUser) {
    setUser(nextUser);
    if (nextUser.emailVerified) {
      await refreshWorkspace();
      const search = new URLSearchParams(window.location.search);
      if (!search.get("change") && !search.get("monitor"))
        setView(
          window.location.pathname === "/settings" ? "settings" : "overview",
        );
      notify("You are signed in. Your monitors are ready.");
    } else {
      notify("Check your email to verify your account.");
    }
  }

  async function handleLogout() {
    try {
      await apiRequest<void>("/api/auth/logout", { method: "POST" });
      clearCsrfToken();
      setUser(null);
      setMonitors([]);
      setChanges([]);
      setView("overview");
      setSelectedMonitorId(null);
      setToast("");
    } catch (error) {
      notify(getErrorMessage(error));
    }
  }

  function navigate(nextView: AppView) {
    setView(nextView);
    setSelectedMonitorId(null);
    setSelectedChangeId(null);
    setSearchQuery("");
    setMobileOpen(false);
  }

  async function openMonitor(
    monitorId: string,
    changeId: string | null = null,
  ) {
    setSelectedMonitorId(monitorId);
    setSelectedChangeId(changeId);
    setView("detail");
    setSearchQuery("");
    setMobileOpen(false);
    try {
      const detail = await apiRequest<{
        monitor: MonitorRecord;
        currentSnapshot: { content: string } | null;
      }>(`/api/monitors/${monitorId}`);
      setMonitors((current) =>
        current.map((monitor) =>
          monitor.id === monitorId
            ? {
                ...mapMonitor(detail.monitor, monitor),
                currentText: detail.currentSnapshot?.content ?? "",
              }
            : monitor,
        ),
      );
    } catch (error) {
      notify(getErrorMessage(error));
    }
  }

  function openCreateDialog() {
    setEditingMonitor(null);
    setDialogOpen(true);
  }

  function openEditDialog(monitor: Monitor) {
    setEditingMonitor(monitor);
    setDialogOpen(true);
  }

  async function saveMonitor(values: MonitorFormValues) {
    if (editingMonitor) {
      await apiRequest(`/api/monitors/${editingMonitor.id}`, {
        method: "PATCH",
        body: values,
      });
      await refreshWorkspace();
      setDialogOpen(false);
      setEditingMonitor(null);
      notify("Monitor settings saved.");
      return;
    }
    const result = await apiRequest<{ monitor: MonitorRecord }>(
      "/api/monitors",
      { method: "POST", body: values },
    );
    await refreshWorkspace();
    setDialogOpen(false);
    setEditingMonitor(null);
    setView("detail");
    setSelectedMonitorId(result.monitor.id);
    setSelectedChangeId(null);
    notify("Monitor added. The first page check has been queued.");
    window.setTimeout(() => {
      void refreshWorkspace().catch(() => undefined);
    }, 2_500);
  }

  async function toggleMonitor(monitor: Monitor) {
    const status = monitor.status === "active" ? "paused" : "active";
    try {
      await apiRequest(`/api/monitors/${monitor.id}/status`, {
        method: "PATCH",
        body: { status },
      });
      await refreshWorkspace();
      notify(
        status === "active"
          ? `${monitor.name} is back on watch.`
          : `${monitor.name} has been paused.`,
      );
    } catch (error) {
      notify(getErrorMessage(error));
    }
  }

  async function runCheck(monitor: Monitor) {
    try {
      await apiRequest(`/api/monitors/${monitor.id}/check`, {
        method: "POST",
        body: {},
      });
      notify("A live page check has been queued.");
      window.setTimeout(() => {
        void refreshWorkspace().catch(() => undefined);
      }, 2_500);
    } catch (error) {
      notify(getErrorMessage(error));
    }
  }

  async function deleteMonitor(monitor: Monitor) {
    if (
      !window.confirm(
        `Delete “${monitor.name}” and its change history? This cannot be undone.`,
      )
    )
      return;
    try {
      await apiRequest<void>(`/api/monitors/${monitor.id}`, {
        method: "DELETE",
      });
      if (selectedMonitorId === monitor.id) {
        setSelectedMonitorId(null);
        setSelectedChangeId(null);
        setView("monitors");
      }
      await refreshWorkspace();
      notify("Monitor and its change history deleted.");
    } catch (error) {
      notify(getErrorMessage(error));
    }
  }

  async function updateNotification(
    key: keyof NotificationSettings,
    value: boolean,
  ) {
    const next = { ...notifications, [key]: value };
    setNotifications(next);
    try {
      const response = await apiRequest<{ preferences: NotificationSettings }>(
        "/api/settings/notifications",
        {
          method: "PATCH",
          body: { [key]: value },
        },
      );
      setNotifications(response.preferences);
      notify("Notification preferences saved.");
    } catch (error) {
      setNotifications(notifications);
      notify(getErrorMessage(error));
    }
  }

  async function startCheckout(plan: "starter" | "business") {
    try {
      const response = await apiRequest<{ url: string }>(
        "/api/billing/checkout",
        { method: "POST", body: { plan } },
      );
      window.location.assign(response.url);
    } catch (error) {
      notify(getErrorMessage(error));
    }
  }

  async function openBillingPortal() {
    try {
      const response = await apiRequest<{ url: string }>(
        "/api/billing/portal",
        { method: "POST", body: {} },
      );
      window.location.assign(response.url);
    } catch (error) {
      notify(getErrorMessage(error));
    }
  }

  const selectedMonitor =
    monitors.find((monitor) => monitor.id === selectedMonitorId) ?? null;
  const activeView: AppView =
    view === "detail" && !selectedMonitor ? "monitors" : view;

  if (bootstrapping) return <FullPageLoading label="Loading your workspace…" />;
  if (!user)
    return (
      <AuthScreen
        initialMessage={workspaceError}
        onSignedIn={handleSignedIn}
        onDevelopmentVerificationToken={setDevVerificationToken}
      />
    );
  if (!user.emailVerified) {
    return (
      <VerificationScreen
        user={user}
        developmentVerificationToken={devVerificationToken}
        onDevelopmentVerificationToken={setDevVerificationToken}
        onRefresh={refreshSession}
        onLogout={handleLogout}
        notify={notify}
      />
    );
  }

  const recentChanges = [...changes].sort(
    (a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt),
  );
  const selectedMonitorChanges = recentChanges.filter(
    (change) => change.monitorId === selectedMonitorId,
  );

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        monitors={monitors}
        mobileOpen={mobileOpen}
        userEmail={user.email}
        plan={usage.plan}
        monitorLimit={usage.limit}
        onNavigate={navigate}
        onAddMonitor={openCreateDialog}
        onOpenMonitor={(id) => {
          void openMonitor(id);
        }}
        onCloseMobile={() => setMobileOpen(false)}
        onLogout={() => {
          void handleLogout();
        }}
      />
      <div className="app-main">
        <TopBar
          onMenu={() => setMobileOpen(true)}
          onSearch={(value) => {
            setSearchQuery(value);
            if (value.trim()) setView("monitors");
          }}
          onHelp={() => navigate("settings")}
          onNotifications={() => navigate("changes")}
          searchValue={searchQuery}
          userEmail={user.email}
        />
        {workspaceError && (
          <div className="workspace-banner" role="alert">
            <CircleAlert size={16} /> {workspaceError}
            <button
              type="button"
              onClick={() => {
                void refreshWorkspace().catch(() => undefined);
              }}
            >
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        )}
        {workspaceLoading && (
          <div className="sync-indicator">
            <LoaderCircle size={14} /> Syncing workspace…
          </div>
        )}
        {view === "overview" && (
          <OverviewPage
            now={currentTime}
            user={user}
            monitors={monitors}
            changes={recentChanges}
            usage={usage}
            onAddMonitor={openCreateDialog}
            onNavigate={navigate}
            onOpenMonitor={(id, changeId) => {
              void openMonitor(id, changeId);
            }}
          />
        )}
        {view === "monitors" && (
          <MonitorsPage
            monitors={monitors}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onAddMonitor={openCreateDialog}
            onOpenMonitor={(id) => {
              void openMonitor(id);
            }}
            onToggleMonitor={(monitor) => {
              void toggleMonitor(monitor);
            }}
            onEditMonitor={openEditDialog}
          />
        )}
        {view === "changes" && (
          <ChangesPage
            now={currentTime}
            changes={recentChanges}
            monitors={monitors}
            onOpenChange={(change) => {
              void openMonitor(change.monitorId, change.id);
            }}
          />
        )}
        {view === "settings" && (
          <SettingsPage
            user={user}
            notifications={notifications}
            usage={usage}
            onUpdateNotification={(key, value) => {
              void updateNotification(key, value);
            }}
            onCheckout={(plan) => {
              void startCheckout(plan);
            }}
            onPortal={() => {
              void openBillingPortal();
            }}
          />
        )}
        {view === "detail" && selectedMonitor && (
          <MonitorDetailPage
            monitor={selectedMonitor}
            changes={selectedMonitorChanges}
            selectedChangeId={selectedChangeId}
            onBack={() => navigate("monitors")}
            onEdit={() => openEditDialog(selectedMonitor)}
            onToggle={() => {
              void toggleMonitor(selectedMonitor);
            }}
            onRunCheck={() => {
              void runCheck(selectedMonitor);
            }}
            onDelete={() => {
              void deleteMonitor(selectedMonitor);
            }}
            onSelectChange={setSelectedChangeId}
          />
        )}
      </div>
      {dialogOpen && (
        <MonitorDialog
          initialMonitor={editingMonitor}
          onClose={() => {
            setDialogOpen(false);
            setEditingMonitor(null);
          }}
          onSave={saveMonitor}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          <span>{toast}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function FullPageLoading({ label }: { label: string }) {
  return (
    <main className="auth-page">
      <div className="auth-card auth-card-compact">
        <span className="product-logo">
          <BrandMark />
        </span>
        <LoaderCircle className="auth-spinner" size={22} />
        <p>{label}</p>
      </div>
    </main>
  );
}

function AuthScreen({
  initialMessage,
  onSignedIn,
  onDevelopmentVerificationToken,
}: {
  initialMessage: string;
  onSignedIn: (user: SessionUser) => Promise<void>;
  onDevelopmentVerificationToken: (token: string | null) => void;
}) {
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(initialMessage);
  const [devToken, setDevToken] = useState("");
  const [devResetToken, setDevResetToken] = useState("");
  const [canResendVerification, setCanResendVerification] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "reset") {
        const result = await apiRequest<{
          message: string;
          developmentPasswordResetToken?: string;
        }>("/api/auth/request-password-reset", {
          method: "POST",
          body: { email },
        });
        setMessage(result.message);
        setDevResetToken(result.developmentPasswordResetToken ?? "");
      } else if (mode === "register") {
        const result = await apiRequest<{ message: string }>(
          "/api/auth/register",
          { method: "POST", body: { email, password } },
        );
        setMode("login");
        setPassword("");
        setCanResendVerification(true);
        setMessage(result.message);
      } else {
        const result = await apiRequest<{
          user: SessionUser;
          csrfToken: string;
        }>("/api/auth/login", { method: "POST", body: { email, password } });
        saveCsrfToken(result.csrfToken);
        await onSignedIn(result.user);
      }
    } catch (submitError) {
      setError(getErrorMessage(submitError));
      if (
        submitError instanceof ApiError &&
        submitError.code === "EMAIL_NOT_VERIFIED"
      ) {
        setMode("login");
        setMessage("Your account still needs email verification.");
        setCanResendVerification(true);
      }
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: "login" | "register" | "reset") {
    setMode(next);
    setError("");
    setMessage("");
    setDevToken("");
    setDevResetToken("");
    setCanResendVerification(false);
  }

  async function resendVerification() {
    setBusy(true);
    try {
      const response = await apiRequest<{
        developmentVerificationToken?: string;
      }>("/api/auth/resend-verification", {
        method: "POST",
        body: { email },
      });
      const token = response.developmentVerificationToken ?? "";
      setDevToken(token);
      onDevelopmentVerificationToken(token || null);
      setMessage(
        "If verification is needed, a fresh link will be sent to that email address.",
      );
    } catch (resendError) {
      setError(getErrorMessage(resendError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-decoration auth-decoration-one" />
      <div className="auth-decoration auth-decoration-two" />
      <section className="auth-card" aria-labelledby="auth-heading">
        <a className="auth-brand" href="/" aria-label="Watchtower home">
          <span className="product-logo">
            <BrandMark />
          </span>
          <span className="product-name">
            watchtower<span className="product-dot">.</span>
          </span>
        </a>
        <div className="auth-eyebrow">WEBSITE CHANGE MONITOR</div>
        <h1 id="auth-heading">
          {mode === "login"
            ? "Welcome back"
            : mode === "register"
              ? "Start watching the web"
              : "Reset your password"}
        </h1>
        <p className="auth-subtitle">
          {mode === "login"
            ? "Sign in to see what changed across your watchlist."
            : mode === "register"
              ? "Create an account and get a clear signal when pages change."
              : "We’ll email you a secure password reset link if an account exists."}
        </p>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="auth-form"
        >
          <label className="auth-label" htmlFor="auth-email">
            Email address
          </label>
          <input
            id="auth-email"
            className="form-input auth-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            maxLength={254}
          />
          {mode !== "reset" && (
            <>
              <label className="auth-label" htmlFor="auth-password">
                Password
              </label>
              <input
                id="auth-password"
                className="form-input auth-input"
                type="password"
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={mode === "register" ? 12 : 1}
                maxLength={128}
              />
              {mode === "register" && (
                <span className="auth-hint">
                  At least 12 characters; use a mix of letters, numbers, and
                  symbols.
                </span>
              )}
            </>
          )}
          {error && (
            <div className="auth-error" role="alert">
              <CircleAlert size={15} />
              {error}
            </div>
          )}
          {message && (
            <div className="auth-message" role="status">
              <CheckCircle2 size={15} />
              {message}
            </div>
          )}
          {mode === "reset" && devResetToken && (
            <a
              className="dev-verification-link"
              href={`/api/auth/reset-password-form?token=${encodeURIComponent(devResetToken)}`}
            >
              Open local password reset link <ArrowUpRight size={14} />
            </a>
          )}
          {devToken && (
            <a
              className="dev-verification-link"
              href={`/api/auth/verify-email?token=${encodeURIComponent(devToken)}`}
            >
              Open local verification link <ArrowUpRight size={14} />
            </a>
          )}
          {canResendVerification && (
            <button
              className="auth-resend-link"
              type="button"
              onClick={() => {
                void resendVerification();
              }}
              disabled={busy}
            >
              Resend verification email
            </button>
          )}
          <button
            className="button button-primary auth-submit"
            type="submit"
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle className="auth-spinner" size={16} />
            ) : mode === "reset" ? (
              "Send reset link"
            ) : mode === "register" ? (
              "Create account"
            ) : (
              "Sign in"
            )}{" "}
            {!busy && <ArrowRight size={15} />}
          </button>
        </form>
        <div className="auth-links">
          {mode === "login" && (
            <button type="button" onClick={() => switchMode("reset")}>
              Forgot password?
            </button>
          )}
          {mode === "register" ? (
            <span>
              Already have an account?{" "}
              <button type="button" onClick={() => switchMode("login")}>
                Sign in
              </button>
            </span>
          ) : mode === "login" ? (
            <span>
              New to Watchtower?{" "}
              <button type="button" onClick={() => switchMode("register")}>
                Create account
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => switchMode("login")}>
              Back to sign in
            </button>
          )}
        </div>
        <div className="auth-security">
          <ShieldCheck size={15} /> Secure sessions · Email verification
          required
        </div>
      </section>
      <div className="auth-footer">
        Monitor public pages responsibly. Your account and watchlist are
        private.
      </div>
    </main>
  );
}

function VerificationScreen({
  user,
  developmentVerificationToken,
  onDevelopmentVerificationToken,
  onRefresh,
  onLogout,
  notify,
}: {
  user: SessionUser;
  developmentVerificationToken: string | null;
  onDevelopmentVerificationToken: (token: string | null) => void;
  onRefresh: () => Promise<SessionUser>;
  onLogout: () => void;
  notify: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  async function resend() {
    setBusy(true);
    try {
      const response = await apiRequest<{
        developmentVerificationToken?: string;
      }>("/api/auth/resend-verification", {
        method: "POST",
        body: { email: user.email },
      });
      onDevelopmentVerificationToken(
        response.developmentVerificationToken ?? developmentVerificationToken,
      );
      setResent(true);
      notify("If verification is still needed, a fresh email is on its way.");
    } catch (error) {
      notify(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function checkVerification() {
    setBusy(true);
    try {
      const refreshed = await onRefresh();
      if (!refreshed.emailVerified) {
        notify(
          "Email verification is not complete yet. Open the link in your email, then try again.",
        );
        return;
      }
      notify("Your email is verified. Welcome to Watchtower.");
    } catch (error) {
      notify(
        error instanceof ApiError && error.status === 403
          ? "Email verification is not complete yet. Open the link in your email, then try again."
          : getErrorMessage(error),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-decoration auth-decoration-one" />
      <section className="auth-card verify-card">
        <a className="auth-brand" href="/">
          <span className="product-logo">
            <BrandMark />
          </span>
          <span className="product-name">
            watchtower<span className="product-dot">.</span>
          </span>
        </a>
        <span className="verify-icon">
          <Bell size={21} />
        </span>
        <div className="auth-eyebrow">ONE LAST STEP</div>
        <h1>Check your inbox</h1>
        <p className="auth-subtitle">
          We sent a verification link to <strong>{user.email}</strong>. Verify
          your address to protect your account and start monitoring pages.
        </p>
        {developmentVerificationToken && (
          <a
            className="dev-verification-link"
            href={`/api/auth/verify-email?token=${encodeURIComponent(developmentVerificationToken)}`}
          >
            Open local verification link <ArrowUpRight size={14} />
          </a>
        )}
        <button
          className="button button-primary auth-submit"
          type="button"
          onClick={() => {
            void checkVerification();
          }}
          disabled={busy}
        >
          {busy ? "Checking…" : "I’ve verified my email"} <Check size={15} />
        </button>
        <button
          className="auth-secondary-action"
          type="button"
          onClick={() => {
            void resend();
          }}
          disabled={busy}
        >
          {resent
            ? "Send another verification email"
            : "Didn’t receive it? Resend email"}
        </button>
        <button
          className="auth-secondary-action muted-action"
          type="button"
          onClick={onLogout}
        >
          <LogOut size={14} /> Sign out
        </button>
      </section>
      <div className="auth-footer">
        The link expires for your security. You can request another at any time.
      </div>
    </main>
  );
}

function OverviewPage({
  now,
  user,
  monitors,
  changes,
  usage,
  onAddMonitor,
  onNavigate,
  onOpenMonitor,
}: {
  now: number;
  user: SessionUser;
  monitors: Monitor[];
  changes: Change[];
  usage: Usage;
  onAddMonitor: () => void;
  onNavigate: (view: AppView) => void;
  onOpenMonitor: (monitorId: string, changeId?: string | null) => void;
}) {
  const activeCount = monitors.filter(
    (monitor) => monitor.status === "active",
  ).length;
  const pausedCount = monitors.filter(
    (monitor) => monitor.status === "paused",
  ).length;
  const errorCount = monitors.filter(
    (monitor) => monitor.status === "error",
  ).length;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1_000;
  const weeklyChanges = changes.filter(
    (change) => Date.parse(change.detectedAt) >= weekAgo,
  );
  const nextMonitor = monitors
    .filter((monitor) => monitor.status === "active" && monitor.nextCheckAt)
    .sort((a, b) => Date.parse(a.nextCheckAt!) - Date.parse(b.nextCheckAt!))[0];
  const health = monitors.length
    ? Math.round(((monitors.length - errorCount) / monitors.length) * 100)
    : 100;
  const today = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <main className="page-content overview-page">
      <div className="page-heading overview-heading">
        <div>
          <div className="date-eyebrow">{formatLongDate()}</div>
          <h1>
            Welcome back <span className="heading-sparkle">✳</span>
          </h1>
          <p>Your watchlist is keeping an eye on the pages that matter.</p>
        </div>
        <div className="heading-actions">
          <span
            className="button button-quiet button-period"
            title="Live data from your monitors"
          >
            <span className="period-dot" /> Live workspace{" "}
            <span className="period-chevron">⌄</span>
          </span>
          <button
            className="button button-primary"
            type="button"
            onClick={onAddMonitor}
          >
            <Plus size={16} /> Add monitor
          </button>
        </div>
      </div>
      <div className="stat-grid">
        <StatCard
          icon={<Globe2 size={17} />}
          accent="green"
          label="Active monitors"
          value={String(activeCount)}
          trend={`${monitors.length} total`}
          trendIcon={<TrendingUp size={13} />}
          footnote={`${monitors.length} of ${usage.limit} plan slots used`}
        />
        <StatCard
          icon={<Bell size={17} />}
          accent="violet"
          label="Changes this week"
          value={String(weeklyChanges.length)}
          trend={weeklyChanges.length ? "New updates" : "All quiet"}
          trendIcon={<Sparkles size={13} />}
          footnote="across your watchlist"
        />
        <StatCard
          icon={<HeartPulse size={17} />}
          accent="blue"
          label="Monitor health"
          value={`${health}%`}
          trend={
            errorCount ? `${errorCount} need attention` : "No active errors"
          }
          trendIcon={<ShieldCheck size={13} />}
          footnote="monitors without failures"
        />
        <StatCard
          icon={<Clock3 size={17} />}
          accent="amber"
          label="Checks this week"
          value={String(usage.checksThisWeek)}
          trend={
            nextMonitor
              ? `Next: ${formatRelativeTime(nextMonitor.nextCheckAt)}`
              : "No check queued"
          }
          trendIcon={<Zap size={13} />}
          footnote={
            nextMonitor ? nextMonitor.name : "Add a page to get started"
          }
        />
      </div>

      <div className="overview-grid">
        <div className="overview-main-column">
          <section className="surface chart-card live-activity-card">
            <div className="card-heading chart-card-heading">
              <div>
                <div className="eyebrow">RECENT ACTIVITY</div>
                <h2>Checks over the last 7 days</h2>
              </div>
              <span className="live-status-label">
                <span /> Live data
              </span>
            </div>
            <div className="activity-summary">
              <strong>{usage.checksThisWeek}</strong>
              <span>successful page snapshots this week</span>
            </div>
            <div
              className="usage-bars"
              aria-label="Daily page checks during the last seven days"
            >
              {usage.checksByDay.map((day) => (
                <div
                  className="usage-bar-column"
                  key={day.date}
                  title={`${day.checks} checks`}
                >
                  <span className="usage-bar-value">{day.checks}</span>
                  <div className="usage-bar-track">
                    <i
                      style={{
                        height: `${Math.max(4, Math.min(100, (day.checks / Math.max(1, ...usage.checksByDay.map((item) => item.checks))) * 100))}%`,
                      }}
                    />
                  </div>
                  <span className="usage-bar-label">
                    {new Intl.DateTimeFormat(undefined, {
                      weekday: "short",
                    }).format(new Date(`${day.date}T12:00:00`))}
                  </span>
                </div>
              ))}
              {usage.checksByDay.length === 0 && (
                <p className="muted-empty">
                  Your first successful checks will appear here.
                </p>
              )}
            </div>
            <div className="chart-footer">
              <span>
                <i className="legend-dot" /> Successful checks
              </span>
              <span>
                <ShieldCheck size={14} /> Failed requests never create change
                alerts
              </span>
            </div>
          </section>
          <section className="surface recent-changes-card">
            <div className="card-heading recent-heading">
              <div>
                <div className="eyebrow">WHAT CHANGED</div>
                <h2>
                  Recent updates{" "}
                  <span className="heading-count">{changes.length}</span>
                </h2>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => onNavigate("changes")}
              >
                View all <ArrowRight size={15} />
              </button>
            </div>
            {changes.length ? (
              <div className="change-list">
                {changes.slice(0, 4).map((change) => {
                  const monitor = monitors.find(
                    (item) => item.id === change.monitorId,
                  );
                  return monitor ? (
                    <ChangeRow
                      key={change.id}
                      change={change}
                      monitor={monitor}
                      compact
                      onClick={() => onOpenMonitor(monitor.id, change.id)}
                    />
                  ) : null;
                })}
              </div>
            ) : (
              <EmptyState
                icon={<Sparkles size={19} />}
                title="No changes just yet"
                text="We’ll show a safe text diff here when one of your pages changes."
                action={
                  <button
                    className="text-button"
                    type="button"
                    onClick={onAddMonitor}
                  >
                    Add your first monitor <ArrowRight size={14} />
                  </button>
                }
              />
            )}
          </section>
        </div>
        <aside className="overview-side-column">
          <HealthCard
            activeCount={activeCount}
            totalCount={monitors.length}
            healthPercent={health}
            errorCount={errorCount}
            pausedCount={pausedCount}
          />
          <section className="surface next-checks-card">
            <div className="card-heading next-check-heading">
              <div>
                <div className="eyebrow">UP NEXT</div>
                <h2>On the watch</h2>
              </div>
              <button
                className="icon-button subtle-icon-button"
                type="button"
                aria-label="View monitors"
                onClick={() => onNavigate("monitors")}
              >
                <ArrowUpRight size={16} />
              </button>
            </div>
            <div className="upcoming-list">
              {monitors
                .filter((monitor) => monitor.status === "active")
                .sort(
                  (a, b) =>
                    Date.parse(a.nextCheckAt ?? "") -
                    Date.parse(b.nextCheckAt ?? ""),
                )
                .slice(0, 4)
                .map((monitor) => (
                  <button
                    className="upcoming-item"
                    type="button"
                    key={monitor.id}
                    onClick={() => onOpenMonitor(monitor.id)}
                  >
                    <BrandMark url={monitor.url} size="small" />
                    <span className="upcoming-item-copy">
                      <strong>{monitor.name}</strong>
                      <span>
                        {formatRelativeTime(monitor.lastCheckedAt)} checked
                      </span>
                    </span>
                    <span className="upcoming-time">
                      {formatRelativeTime(monitor.nextCheckAt)}
                    </span>
                  </button>
                ))}
              {activeCount === 0 && (
                <p className="muted-empty">No active monitors at the moment.</p>
              )}
            </div>
            <button
              className="next-checks-footer"
              type="button"
              onClick={() => onNavigate("monitors")}
            >
              See all monitors <ArrowRight size={14} />
            </button>
          </section>
          <div className="preview-callout">
            <span className="preview-callout-icon">
              <ShieldCheck size={15} />
            </span>
            <p>
              <strong>Private to {user.email}</strong>
              <br />
              Your pages are fetched securely. Page scripts are never run.
            </p>
          </div>
        </aside>
      </div>
      {pausedCount > 0 && (
        <p className="overview-footnote">
          {pausedCount} monitor{pausedCount === 1 ? " is" : "s are"} paused.{" "}
          {today.format(new Date())} local time.
        </p>
      )}
    </main>
  );
}

function StatCard({
  icon,
  accent,
  label,
  value,
  trend,
  trendIcon,
  footnote,
}: {
  icon: ReactNode;
  accent: string;
  label: string;
  value: string;
  trend: string;
  trendIcon: ReactNode;
  footnote: string;
}) {
  return (
    <section className="surface stat-card">
      <div className="stat-top">
        <span className={`stat-icon stat-icon-${accent}`}>{icon}</span>
        <span className="stat-label">{label}</span>
        <span className="stat-more" aria-hidden="true">
          ···
        </span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-bottom">
        <span className={`stat-trend stat-trend-${accent}`}>
          {trendIcon}
          {trend}
        </span>
        <span className="stat-footnote">{footnote}</span>
      </div>
    </section>
  );
}

function MonitorsPage({
  monitors,
  searchQuery,
  onSearchChange,
  onAddMonitor,
  onOpenMonitor,
  onToggleMonitor,
  onEditMonitor,
}: {
  monitors: Monitor[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onAddMonitor: () => void;
  onOpenMonitor: (monitorId: string) => void;
  onToggleMonitor: (monitor: Monitor) => void;
  onEditMonitor: (monitor: Monitor) => void;
}) {
  const [filter, setFilter] = useState<"all" | Monitor["status"]>("all");
  const filtered = useMemo(
    () =>
      monitors
        .filter((monitor) => filter === "all" || monitor.status === filter)
        .filter((monitor) =>
          `${monitor.name} ${monitor.url} ${monitor.selector}`
            .toLowerCase()
            .includes(searchQuery.toLowerCase().trim()),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [filter, monitors, searchQuery],
  );
  const counts = {
    all: monitors.length,
    active: monitors.filter((monitor) => monitor.status === "active").length,
    paused: monitors.filter((monitor) => monitor.status === "paused").length,
    error: monitors.filter((monitor) => monitor.status === "error").length,
  };
  const next = monitors
    .filter((monitor) => monitor.status === "active" && monitor.nextCheckAt)
    .sort((a, b) => Date.parse(a.nextCheckAt!) - Date.parse(b.nextCheckAt!))[0];
  return (
    <main className="page-content monitors-page">
      <div className="page-heading">
        <div>
          <div className="date-eyebrow">YOUR WATCHLIST</div>
          <h1>
            Monitors{" "}
            <span className="heading-count heading-count-large">
              {monitors.length}
            </span>
          </h1>
          <p>Keep an eye on the pages that matter to you.</p>
        </div>
        <button
          className="button button-primary"
          type="button"
          onClick={onAddMonitor}
        >
          <Plus size={16} /> Add monitor
        </button>
      </div>
      <div className="monitor-overview-strip">
        <div>
          <span className="mini-health-dot" />
          <strong>{counts.active} active</strong>
          <span>checking the web for you</span>
        </div>
        <span className="strip-divider" />
        <div>
          <Clock3 size={15} />
          <span>Next check</span>
          <strong>{formatRelativeTime(next?.nextCheckAt ?? null)}</strong>
        </div>
        <div className="strip-right-note">
          <ShieldCheck size={15} /> Private to your account
        </div>
      </div>
      <section className="surface monitor-list-surface">
        <div className="list-toolbar">
          <div
            className="filter-tabs"
            role="tablist"
            aria-label="Filter monitors"
          >
            {(["all", "active", "paused", "error"] as const).map((value) => (
              <button
                className={`filter-tab ${filter === value ? "filter-tab-active" : ""}`}
                type="button"
                role="tab"
                aria-selected={filter === value}
                key={value}
                onClick={() => setFilter(value)}
              >
                {value === "all"
                  ? "All monitors"
                  : value === "error"
                    ? "Needs attention"
                    : `${value.charAt(0).toUpperCase()}${value.slice(1)}`}
                <span>{counts[value]}</span>
              </button>
            ))}
          </div>
          <label className="list-search">
            <Search size={15} />
            <input
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Filter by name or URL"
            />
            <kbd>/</kbd>
          </label>
        </div>
        <div className="monitor-table-wrap">
          <table className="monitor-table">
            <thead>
              <tr>
                <th>MONITOR</th>
                <th>STATUS</th>
                <th>FREQUENCY</th>
                <th>LAST CHECKED</th>
                <th>NEXT CHECK</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((monitor) => (
                <tr key={monitor.id}>
                  <td>
                    <button
                      className="table-monitor-cell"
                      type="button"
                      onClick={() => onOpenMonitor(monitor.id)}
                    >
                      <BrandMark url={monitor.url} />
                      <span>
                        <strong>{monitor.name}</strong>
                        <span>{displayPath(monitor.url)}</span>
                      </span>
                    </button>
                  </td>
                  <td>
                    <StatusPill status={monitor.status} />
                  </td>
                  <td>
                    <span className="table-frequency">
                      <Clock3 size={14} />
                      {FREQUENCY_LABELS[monitor.frequency]}
                    </span>
                  </td>
                  <td>
                    <span className="table-time">
                      {formatRelativeTime(monitor.lastCheckedAt)}
                    </span>
                  </td>
                  <td>
                    <span className="table-time">
                      {monitor.status === "paused"
                        ? "Paused"
                        : !monitor.baselineEstablished
                          ? "Awaiting snapshot"
                          : formatRelativeTime(monitor.nextCheckAt)}
                    </span>
                  </td>
                  <td>
                    <div className="table-actions">
                      <button
                        className="icon-button table-action"
                        type="button"
                        aria-label={`Edit ${monitor.name}`}
                        title="Edit monitor"
                        onClick={() => onEditMonitor(monitor)}
                      >
                        <span className="edit-glyph">✎</span>
                      </button>
                      <button
                        className="icon-button table-action"
                        type="button"
                        aria-label={
                          monitor.status === "active"
                            ? `Pause ${monitor.name}`
                            : `Resume ${monitor.name}`
                        }
                        title={
                          monitor.status === "active"
                            ? "Pause monitor"
                            : "Resume monitor"
                        }
                        onClick={() => onToggleMonitor(monitor)}
                      >
                        {monitor.status === "active" ? (
                          <Pause size={15} />
                        ) : (
                          <Play size={15} />
                        )}
                      </button>
                      <button
                        className="icon-button table-action view-action"
                        type="button"
                        aria-label={`View ${monitor.name}`}
                        title="View monitor"
                        onClick={() => onOpenMonitor(monitor.id)}
                      >
                        <ArrowUpRight size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <EmptyState
              icon={<Search size={18} />}
              title="No monitors found"
              text={
                monitors.length
                  ? "Try a different search or status filter."
                  : "Add your first public page to start keeping watch."
              }
              action={
                !monitors.length ? (
                  <button
                    className="button button-primary button-small"
                    type="button"
                    onClick={onAddMonitor}
                  >
                    <Plus size={14} /> Add monitor
                  </button>
                ) : undefined
              }
            />
          )}
        </div>
        <div className="monitor-list-footer">
          <span>
            Showing <strong>{filtered.length}</strong> of {monitors.length}{" "}
            monitors
          </span>
          <span>
            <ShieldCheck size={14} /> Your account data stays private
          </span>
        </div>
      </section>
    </main>
  );
}

function ChangesPage({
  now,
  changes,
  monitors,
  onOpenChange,
}: {
  now: number;
  changes: Change[];
  monitors: Monitor[];
  onOpenChange: (change: Change) => void;
}) {
  const [selectedMonitor, setSelectedMonitor] = useState("all");
  const [range, setRange] = useState("all");
  const sorted = [...changes].sort(
    (a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt),
  );
  const filtered = sorted.filter((change) => {
    const matchesMonitor =
      selectedMonitor === "all" || change.monitorId === selectedMonitor;
    const age = now - Date.parse(change.detectedAt);
    const matchesRange =
      range === "all" ||
      (range === "7d" && age <= 7 * 24 * 60 * 60 * 1_000) ||
      (range === "30d" && age <= 30 * 24 * 60 * 60 * 1_000);
    return matchesMonitor && matchesRange;
  });
  return (
    <main className="page-content changes-page">
      <div className="page-heading">
        <div>
          <div className="date-eyebrow">YOUR CHANGE LOG</div>
          <h1>Change history</h1>
          <p>A clear timeline of what changed, and when it did.</p>
        </div>
        <div className="heading-meta">
          <span className="history-total">
            <span className="history-dot" /> {changes.length} updates found
          </span>
        </div>
      </div>
      <div className="change-filter-row">
        <label className="select-wrap">
          <Filter size={15} />
          <select
            aria-label="Filter changes by monitor"
            value={selectedMonitor}
            onChange={(event) => setSelectedMonitor(event.target.value)}
          >
            <option value="all">All monitors</option>
            {monitors.map((monitor) => (
              <option value={monitor.id} key={monitor.id}>
                {monitor.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <label className="select-wrap">
          <Clock3 size={15} />
          <select
            aria-label="Filter changes by date"
            value={range}
            onChange={(event) => setRange(event.target.value)}
          >
            <option value="all">Any time</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <ChevronDown size={14} />
        </label>
        <div className="change-filter-note">
          <ShieldCheck size={14} /> Failed page requests never create false
          changes
        </div>
      </div>
      {filtered.length ? (
        <div className="changes-timeline">
          <div className="timeline-date-label">
            <span /> LATEST UPDATES
          </div>
          <section className="surface changes-list-surface">
            {filtered.map((change) => {
              const monitor = monitors.find(
                (item) => item.id === change.monitorId,
              );
              return monitor ? (
                <ChangeRow
                  key={change.id}
                  change={change}
                  monitor={monitor}
                  onClick={() => onOpenChange(change)}
                />
              ) : null;
            })}
          </section>
          <div className="timeline-end">
            <span /> You’re all caught up
          </div>
        </div>
      ) : (
        <section className="surface empty-change-state">
          <EmptyState
            icon={<ListChecks size={20} />}
            title="No changes in this view"
            text="Try another time range or monitor. New updates will appear here when page content changes."
          />
        </section>
      )}
    </main>
  );
}

function MonitorDetailPage({
  monitor,
  changes,
  selectedChangeId,
  onBack,
  onEdit,
  onToggle,
  onRunCheck,
  onDelete,
  onSelectChange,
}: {
  monitor: Monitor;
  changes: Change[];
  selectedChangeId: string | null;
  onBack: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRunCheck: () => void;
  onDelete: () => void;
  onSelectChange: (changeId: string) => void;
}) {
  const sortedChanges = [...changes].sort(
    (a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt),
  );
  const selectedChange =
    sortedChanges.find((change) => change.id === selectedChangeId) ??
    sortedChanges[0] ??
    null;
  const difference = selectedChange?.diff?.length
    ? selectedChange.diff
    : selectedChange
      ? diffText(selectedChange.previousText, selectedChange.newText)
      : [];
  const addedCount = difference.filter((line) => line.kind === "added").length;
  const removedCount = difference.filter(
    (line) => line.kind === "removed",
  ).length;
  const nextLabel =
    monitor.status === "paused"
      ? "Paused"
      : monitor.baselineEstablished
        ? formatRelativeTime(monitor.nextCheckAt)
        : "Awaiting baseline";
  return (
    <main className="page-content detail-page">
      <button className="back-link" type="button" onClick={onBack}>
        <ArrowLeft size={15} /> Back to monitors
      </button>
      <div className="detail-heading">
        <div className="detail-title-group">
          <BrandMark url={monitor.url} size="large" />
          <div className="detail-title-copy">
            <div className="detail-kicker">
              MONITOR DETAILS <span>·</span>{" "}
              {monitor.id.slice(0, 12).toUpperCase()}
            </div>
            <h1>{monitor.name}</h1>
            <a
              className="detail-url"
              href={monitor.url}
              target="_blank"
              rel="noreferrer"
            >
              <span>{displayPath(monitor.url)}</span>
              <ExternalLink size={13} />
            </a>
          </div>
          <div className="detail-status">
            <StatusPill status={monitor.status} />
          </div>
        </div>
        <div className="detail-actions">
          <button
            className="button button-quiet"
            type="button"
            onClick={onEdit}
          >
            Edit monitor
          </button>
          <button
            className="button button-quiet"
            type="button"
            onClick={onToggle}
          >
            {monitor.status === "active" ? (
              <>
                <Pause size={14} /> Pause
              </>
            ) : (
              <>
                <Play size={14} /> Resume
              </>
            )}
          </button>
          <button
            className="button button-primary"
            type="button"
            onClick={onRunCheck}
          >
            <RefreshCw size={15} /> Check now
          </button>
        </div>
      </div>
      {monitor.status === "error" && (
        <div className="detail-alert">
          <CircleAlert size={16} />
          <span>
            <strong>Checks need attention.</strong> Recent checks could not
            complete. Review the page settings or resume it to try again.
          </span>
          <button type="button" onClick={onToggle}>
            Resume monitor <ArrowRight size={14} />
          </button>
        </div>
      )}
      <div className="detail-stat-grid">
        <DetailStat
          icon={<Clock3 size={16} />}
          label="Last checked"
          value={formatRelativeTime(monitor.lastCheckedAt)}
          foot={formatDateTime(monitor.lastCheckedAt)}
        />
        <DetailStat
          icon={<Zap size={16} />}
          label="Next check"
          value={nextLabel}
          foot={FREQUENCY_LABELS[monitor.frequency]}
        />
        <DetailStat
          icon={<TrendingUp size={16} />}
          label="Changes detected"
          value={String(changes.length)}
          foot={
            monitor.lastChangedAt
              ? `Last change ${formatRelativeTime(monitor.lastChangedAt)}`
              : "No changes detected yet"
          }
        />
        <DetailStat
          icon={<ShieldCheck size={16} />}
          label="Successful checks"
          value={String(monitor.checkCount)}
          foot={`${monitor.checkCount} snapshots on record`}
        />
      </div>
      <div className="detail-body-grid">
        <section className="surface diff-card">
          <div className="diff-card-header">
            <div>
              <div className="eyebrow">CONTENT COMPARISON</div>
              <h2>
                {selectedChange
                  ? "A change worth knowing"
                  : "Current page snapshot"}
              </h2>
            </div>
            {selectedChange ? (
              <div className="diff-counts">
                <span className="diff-add-count">
                  <Plus size={12} /> {addedCount} added
                </span>
                <span className="diff-remove-count">
                  <span>−</span> {removedCount} removed
                </span>
              </div>
            ) : (
              <BaselinePill established={monitor.baselineEstablished} />
            )}
          </div>
          {selectedChange ? (
            <>
              <div className="diff-meta">
                <span>
                  <Clock3 size={13} /> Detected{" "}
                  {formatDateTime(selectedChange.detectedAt)}
                </span>
                <span className="diff-meta-separator">·</span>
                <span>Compared with the previous snapshot</span>
              </div>
              <DiffViewer lines={difference} />
            </>
          ) : (
            <div className="snapshot-view">
              {monitor.baselineEstablished ? (
                monitor.currentText
                  .split("\n")
                  .map((line, index) => <p key={`${index}-${line}`}>{line}</p>)
              ) : (
                <div className="snapshot-empty">
                  <LoaderCircle size={19} />
                  <strong>Waiting for a first snapshot</strong>
                  <span>
                    The first safe page check is queued. You can also run one
                    now.
                  </span>
                  <button
                    className="button button-primary button-small"
                    type="button"
                    onClick={onRunCheck}
                  >
                    <RefreshCw size={14} /> Check now
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="diff-card-footer">
            <span>
              <ShieldCheck size={14} /> Page content is rendered as text for
              safety
            </span>
            <span>Secure HTTP(S) fetch</span>
          </div>
        </section>
        <aside className="detail-side-column">
          <section className="surface history-card">
            <div className="card-heading history-card-heading">
              <div>
                <div className="eyebrow">ACTIVITY</div>
                <h2>
                  Change history{" "}
                  <span className="heading-count">{changes.length}</span>
                </h2>
              </div>
              <span className="history-mini-icon">
                <Activity size={16} />
              </span>
            </div>
            {sortedChanges.length ? (
              <div className="detail-history-list">
                {sortedChanges.map((change) => {
                  const diff = change.diff?.length
                    ? change.diff
                    : diffText(change.previousText, change.newText);
                  const count = diff.filter(
                    (line) => line.kind !== "unchanged",
                  ).length;
                  return (
                    <button
                      key={change.id}
                      type="button"
                      className={`detail-history-item ${selectedChange?.id === change.id ? "is-selected" : ""}`}
                      onClick={() => onSelectChange(change.id)}
                    >
                      <span className="history-item-marker" />
                      <span className="history-item-copy">
                        <strong>
                          {count}{" "}
                          {count === 1 ? "content change" : "content changes"}
                        </strong>
                        <span>{formatDateTime(change.detectedAt)}</span>
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="detail-no-history">
                <span className="quiet-icon">
                  <Sparkles size={16} />
                </span>
                <strong>No changes yet</strong>
                <p>
                  When a page changes, the before and after will appear here.
                </p>
              </div>
            )}
            <div className="history-footer">
              <span>
                <span className="history-dot" />{" "}
                {monitor.status === "active"
                  ? "Watching this page"
                  : monitor.status === "paused"
                    ? "Monitoring paused"
                    : "Check needs attention"}
              </span>
            </div>
          </section>
          <section className="surface monitor-config-card">
            <div className="card-heading">
              <div>
                <div className="eyebrow">CONFIGURATION</div>
                <h2>Watch settings</h2>
              </div>
              <button
                type="button"
                className="icon-button subtle-icon-button"
                onClick={onEdit}
                aria-label="Edit watch settings"
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <ConfigRow
              label="Frequency"
              value={FREQUENCY_LABELS[monitor.frequency]}
              icon={<Clock3 size={14} />}
            />
            <ConfigRow
              label="Page selector"
              value={monitor.selector || "Main page content"}
              icon={<Link2 size={14} />}
            />
            <ConfigRow
              label="Baseline"
              value={
                monitor.baselineEstablished ? "Snapshot saved" : "Not started"
              }
              icon={<ShieldCheck size={14} />}
            />
            <button
              className="delete-monitor-button detail-delete"
              type="button"
              onClick={onDelete}
            >
              <Trash2 size={14} /> Delete this monitor
            </button>
          </section>
        </aside>
      </div>
    </main>
  );
}

function DetailStat({
  icon,
  label,
  value,
  foot,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  foot: string;
}) {
  return (
    <div className="surface detail-stat">
      <span className="detail-stat-icon">{icon}</span>
      <span className="detail-stat-label">{label}</span>
      <strong>{value}</strong>
      <span className="detail-stat-foot">{foot}</span>
    </div>
  );
}

function DiffViewer({ lines }: { lines: DiffLine[] }) {
  const maxVisibleLines = 60;
  return (
    <div
      className="diff-viewer"
      role="region"
      aria-label="Text change comparison"
    >
      {lines.slice(0, maxVisibleLines).map((line, index) => (
        <div
          className={`diff-line diff-line-${line.kind}`}
          key={`${index}-${line.kind}`}
        >
          <span className="diff-line-sign" aria-hidden="true">
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
          </span>
          <span className="diff-line-text">
            {line.text.slice(0, 400)}
            {line.text.length > 400 ? "…" : ""}
          </span>
        </div>
      ))}
      {lines.length === 0 && (
        <div className="diff-no-visible-change">No text difference found.</div>
      )}
      {lines.length > maxVisibleLines && (
        <div className="diff-truncated">
          Showing the first {maxVisibleLines} lines of a large change.
        </div>
      )}
    </div>
  );
}

function ConfigRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: ReactNode;
}) {
  return (
    <div className="config-row">
      <span className="config-icon">{icon}</span>
      <span className="config-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingsPage({
  user,
  notifications,
  usage,
  onUpdateNotification,
  onCheckout,
  onPortal,
}: {
  user: SessionUser;
  notifications: NotificationSettings;
  usage: Usage;
  onUpdateNotification: (
    key: keyof NotificationSettings,
    value: boolean,
  ) => void;
  onCheckout: (plan: "starter" | "business") => void;
  onPortal: () => void;
}) {
  return (
    <main className="page-content settings-page">
      <div className="page-heading">
        <div>
          <div className="date-eyebrow">MAKE IT YOURS</div>
          <h1>Settings</h1>
          <p>Manage your account, plan, and notification preferences.</p>
        </div>
        <span className="settings-saved">
          <CheckCircle2 size={15} /> Synced to your account
        </span>
      </div>
      <div className="settings-layout">
        <div className="settings-main-column">
          <section className="surface settings-section">
            <div className="settings-section-heading">
              <span className="settings-section-icon profile-icon">
                <Globe2 size={16} />
              </span>
              <div>
                <h2>Account</h2>
                <p>Your Watchtower account details.</p>
              </div>
            </div>
            <div className="settings-profile-row">
              <div className="settings-avatar">{initials(user.email)}</div>
              <div>
                <strong>{user.email}</strong>
                <span>Email verified</span>
              </div>
            </div>
            <div className="settings-field-grid">
              <div>
                <span className="settings-field-label">Plan</span>
                <strong>
                  {usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1)}
                </strong>
              </div>
              <div>
                <span className="settings-field-label">Monitors</span>
                <strong>
                  {usage.monitors} of {usage.limit} used
                </strong>
              </div>
            </div>
          </section>
          <section className="surface settings-section notification-settings">
            <div className="settings-section-heading">
              <span className="settings-section-icon notification-settings-icon">
                <Bell size={16} />
              </span>
              <div>
                <h2>Notifications</h2>
                <p>Choose which updates you’d like to hear about.</p>
              </div>
            </div>
            <PreferenceRow
              icon={<Bell size={16} />}
              title="Change alerts"
              description="Get an email when a monitored page changes."
              enabled={notifications.emailAlerts}
              onChange={(value) => onUpdateNotification("emailAlerts", value)}
              badge="Recommended"
            />
            <PreferenceRow
              icon={<Clock3 size={16} />}
              title="Weekly digest"
              description="Get one email on Monday with changes from the previous seven days."
              enabled={notifications.weeklyDigest}
              onChange={(value) => onUpdateNotification("weeklyDigest", value)}
            />
            <PreferenceRow
              icon={<CircleAlert size={16} />}
              title="Monitor failure alerts"
              description="Get an email when repeated check failures pause a monitor."
              enabled={notifications.failureAlerts}
              onChange={(value) => onUpdateNotification("failureAlerts", value)}
            />
            <div className="settings-note">
              <ShieldCheck size={14} /> Email delivery requires the deployment’s
              configured mail provider. Weekly digests are sent Mondays at 09:00
              UTC.
            </div>
          </section>
          <section className="surface settings-section">
            <div className="settings-section-heading">
              <span className="settings-section-icon data-icon">
                <ShieldCheck size={16} />
              </span>
              <div>
                <h2>Security & privacy</h2>
                <p>How we handle monitored pages.</p>
              </div>
            </div>
            <ul className="privacy-list">
              <li>
                <Check size={14} /> Only public HTTP(S) addresses are allowed.
              </li>
              <li>
                <Check size={14} /> DNS is checked before each request and
                redirect.
              </li>
              <li>
                <Check size={14} /> Page scripts are never executed; snapshots
                store extracted text.
              </li>
              <li>
                <Check size={14} /> Your monitors and change history are scoped
                to your account.
              </li>
            </ul>
          </section>
        </div>
        <aside className="settings-aside">
          <section className="plan-details-card">
            <div className="plan-details-eyebrow">
              <span className="plan-card-icon">
                <Zap size={14} />
              </span>{" "}
              CURRENT PLAN
            </div>
            <h2>
              {usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1)}{" "}
              <span>Plan</span>
            </h2>
            <p>
              {usage.monitors} of {usage.limit} monitor slots in use.
            </p>
            <div className="plan-usage">
              <div>
                <span>Monitor slots used</span>
                <strong>
                  {usage.monitors} <span>of {usage.limit}</span>
                </strong>
              </div>
              <div className="plan-progress plan-progress-light">
                <span
                  style={{
                    width: `${usage.limit ? Math.min(100, (usage.monitors / usage.limit) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
            <div className="plan-feature">
              <Check size={14} /> Secure scheduled checks
            </div>
            <div className="plan-feature">
              <Check size={14} /> Text snapshots and change history
            </div>
            <div className="plan-feature">
              <Check size={14} /> Email change alerts when configured
            </div>
            {usage.plan === "free" ? (
              <>
                <button
                  className="button button-plan"
                  type="button"
                  onClick={() => onCheckout("starter")}
                >
                  Upgrade to Starter <ArrowUpRight size={14} />
                </button>
                <button
                  className="button button-quiet settings-business-button"
                  type="button"
                  onClick={() => onCheckout("business")}
                >
                  Explore Business
                </button>
              </>
            ) : (
              <button
                className="button button-plan"
                type="button"
                onClick={onPortal}
              >
                Manage billing <ArrowUpRight size={14} />
              </button>
            )}
          </section>
          <div className="privacy-card">
            <span>
              <ShieldCheck size={17} />
            </span>
            <strong>Your data is yours</strong>
            <p>
              Account data is private and can be deleted with your monitors and
              history.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

function PreferenceRow({
  icon,
  title,
  description,
  enabled,
  onChange,
  badge,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
  badge?: string;
}) {
  return (
    <div className="preference-row">
      <span className="preference-icon">{icon}</span>
      <span className="preference-copy">
        <span>
          <strong>{title}</strong>
          {badge && <em>{badge}</em>}
        </span>
        <span>{description}</span>
      </span>
      <button
        type="button"
        className={`toggle-switch ${enabled ? "toggle-on" : ""}`}
        role="switch"
        aria-checked={enabled}
        aria-label={title}
        onClick={() => onChange(!enabled)}
      >
        <span />
      </button>
    </div>
  );
}

function HealthCard({
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
  return (
    <section className="surface health-card">
      <div className="card-heading">
        <div>
          <div className="eyebrow">WORKSPACE HEALTH</div>
          <h2>{errorCount > 0 ? "Attention needed" : "All systems calm"}</h2>
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
            <span>monitors healthy</span>
          </div>
        </div>
        <div className="health-copy">
          <div className="health-copy-line">
            <span className="health-green-dot" />
            <strong>{activeCount} monitors</strong> are active
          </div>
          <p>
            {totalCount === 0
              ? "Add a page to begin monitoring."
              : errorCount
                ? `${errorCount} monitor${errorCount > 1 ? "s need" : " needs"} attention.`
                : "No active errors have been recorded."}
          </p>
        </div>
      </div>
      <div className="health-card-footer">
        <span className="health-live-dot" /> Monitor status{" "}
        <span className="health-status-text">
          {errorCount
            ? `${errorCount} issue${errorCount > 1 ? "s" : ""}`
            : pausedCount
              ? `${pausedCount} paused`
              : "Looking good"}
        </span>
      </div>
    </section>
  );
}

function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">{icon}</span>
      <strong>{title}</strong>
      <p>{text}</p>
      {action}
    </div>
  );
}
