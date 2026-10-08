import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = randomUUID().replaceAll("-", "");
const apiOrigin =
  process.env.QUALIFICATION_API_ORIGIN ?? "http://127.0.0.1:4000";
const appOrigin = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
const fixtureOrigin =
  process.env.TEST_FIXTURE_ORIGIN ?? "http://fixture.test:18088";
const fixtureControlUrl =
  process.env.FIXTURE_CONTROL_URL ?? "http://127.0.0.1:18088/__control";
const externalStack = Boolean(process.env.QUALIFICATION_API_ORIGIN);
const fixturePort = Number(process.env.FIXTURE_PORT ?? 18_088);
const apiPort = Number(process.env.QUALIFICATION_API_PORT ?? 4_000);
const children = new Set();
const createdEmails = new Set();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let stopping = false;
let testAccount;

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL must point to disposable PostgreSQL.");

try {
  if (!externalStack) {
    const runtimeEnv = {
      ...process.env,
      NODE_ENV: "test",
      SESSION_SECRET:
        process.env.SESSION_SECRET ??
        "qualification-session-secret-not-for-production",
      APP_ORIGIN: appOrigin,
      APP_BASE_URL: appOrigin,
      TEST_FIXTURE_ORIGIN: fixtureOrigin,
      TEST_FIXTURE_ADDRESS: process.env.TEST_FIXTURE_ADDRESS ?? "127.0.0.1",
      ALLOW_DEV_VERIFICATION_TOKEN: "true",
      SCHEDULER_INTERVAL_MS: "1000",
      FETCH_TIMEOUT_MS: "1000",
      FETCH_MAX_REDIRECTS: "0",
      FETCH_DOMAIN_COOLDOWN_MS: "250",
    };

    startChild(
      "Qualification HTTP fixture",
      [path.join(root, "scripts/e2e/http-fixture.mjs")],
      { ...runtimeEnv, FIXTURE_PORT: String(fixturePort) },
    );
    await waitForHttp(`http://127.0.0.1:${fixturePort}/__health`, 10_000);
    startChild(
      "API",
      ["--import", "tsx", path.join(root, "src/server/api.ts")],
      { ...runtimeEnv, PORT: String(apiPort) },
    );
    await waitForApiReady(`${apiOrigin}/ready`, 45_000);
    startChild(
      "Worker",
      ["--import", "tsx", path.join(root, "src/server/worker.ts")],
      runtimeEnv,
    );
    startChild(
      "Scheduler",
      ["--import", "tsx", path.join(root, "src/server/scheduler.ts")],
      runtimeEnv,
    );
  } else {
    await waitForApiReady(`${apiOrigin}/ready`, 45_000);
    const fixtureHealth = new URL(fixtureControlUrl);
    fixtureHealth.pathname = "/__health";
    fixtureHealth.search = "";
    const response = await fetch(fixtureHealth);
    if (!response.ok)
      throw new Error("The Compose HTTP fixture is not healthy.");
  }

  await verifyLivenessAndReadiness(apiOrigin);
  await verifyRedisOutageReadiness();

  const email = `qualification-${runId}@example.com`;
  const password = "GoodPassword!234";
  createdEmails.add(email);
  const session = await createSession(apiOrigin);
  const registration = await postJson(apiOrigin, "/api/auth/register", {
    cookie: session.cookie,
    csrfToken: session.csrfToken,
    origin: appOrigin,
    body: { email, password },
  });
  assertStatus(registration.response, 202, "registration");

  const duplicateEmailRegistration = await postJson(
    apiOrigin,
    "/api/auth/register",
    {
      cookie: session.cookie,
      csrfToken: session.csrfToken,
      origin: appOrigin,
      body: { email, password },
    },
  );
  const newEmail = `qualification-enumeration-${runId}@example.com`;
  createdEmails.add(newEmail);
  const newEmailRegistration = await postJson(apiOrigin, "/api/auth/register", {
    cookie: session.cookie,
    csrfToken: session.csrfToken,
    origin: appOrigin,
    body: { email: newEmail, password },
  });
  assertStatus(
    duplicateEmailRegistration.response,
    202,
    "duplicate registration",
  );
  assertStatus(newEmailRegistration.response, 202, "new-address registration");
  if (
    JSON.stringify(duplicateEmailRegistration.body) !==
    JSON.stringify(newEmailRegistration.body)
  ) {
    throw new Error(
      "Registration responses disclose whether an address exists.",
    );
  }

  const resend = await postJson(apiOrigin, "/api/auth/resend-verification", {
    cookie: session.cookie,
    csrfToken: session.csrfToken,
    origin: appOrigin,
    body: { email },
  });
  assertStatus(resend.response, 200, "verification token issuance");
  if (!resend.body.developmentVerificationToken)
    throw new Error("The test-only verification token was not returned.");
  const verified = await fetch(
    `${apiOrigin}/api/auth/verify-email?token=${encodeURIComponent(resend.body.developmentVerificationToken)}`,
  );
  if (!verified.ok) throw new Error("The verification flow did not complete.");

  const login = await postJson(apiOrigin, "/api/auth/login", {
    cookie: session.cookie,
    csrfToken: session.csrfToken,
    origin: appOrigin,
    body: { email, password },
  });
  assertStatus(login.response, 200, "login");
  const authenticated = {
    cookie: getSessionCookie(login.response.headers) ?? session.cookie,
    csrfToken: login.body.csrfToken,
  };
  testAccount = { email, authenticated };

  const invalidUrl = await postJson(apiOrigin, "/api/monitors", {
    ...authenticated,
    origin: appOrigin,
    body: { name: "invalid", url: "http://localhost/", frequency: "daily" },
  });
  assertStatus(invalidUrl.response, 400, "invalid URL rejection");

  const anonymous = await fetch(`${apiOrigin}/api/monitors/not-a-real-monitor`);
  assertStatus(anonymous, 401, "unauthorized monitor read");

  await setFixture({ content: "Qualification fixture baseline v1" });
  const monitorResult = await postJson(apiOrigin, "/api/monitors", {
    ...authenticated,
    origin: appOrigin,
    body: {
      name: "Qualification fixture",
      url: `${fixtureOrigin}/`,
      frequency: "daily",
    },
  });
  assertStatus(monitorResult.response, 201, "monitor creation");
  const monitorId = monitorResult.body.monitor.id;
  const baseline = await waitForMonitorSnapshot(
    apiOrigin,
    authenticated.cookie,
    monitorId,
    (snapshot) => snapshot?.content === "Qualification fixture baseline v1",
    20_000,
  );
  if (!baseline)
    throw new Error("The worker did not persist the initial snapshot.");
  console.log(
    "Distributed path: monitor → BullMQ → worker → fetch → baseline snapshot.",
  );

  const initialList = await getJson(
    apiOrigin,
    "/api/monitors",
    authenticated.cookie,
  );
  const initialCount = initialList.body.monitors.find(
    (monitor) => monitor.id === monitorId,
  )?.checkCount;
  if (!Number.isInteger(initialCount) || initialCount < 1)
    throw new Error("The initial PostgreSQL snapshot count was not persisted.");

  await setFixture({ content: "Qualification fixture changed to v2" });
  await pool.query(
    `UPDATE monitors
     SET last_checked_at = NULL, next_check_at = now() + interval '1 hour'
     WHERE id = $1`,
    [monitorId],
  );
  const checkRequest = await postJson(
    apiOrigin,
    `/api/monitors/${monitorId}/check`,
    { ...authenticated, origin: appOrigin, body: {} },
  );
  assertStatus(checkRequest.response, 202, "manual queue request");

  const changed = await waitForMonitorSnapshot(
    apiOrigin,
    authenticated.cookie,
    monitorId,
    (snapshot, details) =>
      snapshot?.content === "Qualification fixture changed to v2" &&
      details.changes.length === 1,
    20_000,
  );
  if (!changed) throw new Error("The worker did not persist a content change.");
  const outbox = await waitForOutbox(monitorId, 15_000);
  if (!outbox || !["not_configured", "pending"].includes(outbox.status))
    throw new Error("The change notification outbox was not persisted.");
  console.log(
    "Distributed path: change → diff → PostgreSQL transaction → notification outbox.",
  );

  await verifySchedulerRequeuesDueMonitor(
    apiOrigin,
    authenticated.cookie,
    monitorId,
    initialCount,
  );
  await verifyWorkerRetry(apiOrigin, authenticated, runId);
  await verifyWorkerFailurePersistence(apiOrigin, authenticated, runId);
  await verifyMigrationBackedWorkflowRows(monitorId);
  console.log("Combined PostgreSQL + Redis qualification passed.");
} catch (error) {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(error);
  const annotationMessage = message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  process.stderr.write(
    `::error title=Combined workflow qualification::${annotationMessage}\n`,
  );
  process.exitCode = 1;
} finally {
  if (testAccount) {
    const { cookie } = testAccount.authenticated;
    const logout = await postJson(apiOrigin, "/api/auth/logout", {
      cookie,
      csrfToken: testAccount.authenticated.csrfToken,
      origin: appOrigin,
    }).catch(() => undefined);
    void logout;
  }
  for (const email of createdEmails)
    await pool
      .query("DELETE FROM users WHERE email = $1", [email])
      .catch(() => undefined);
  await pool.end().catch(() => undefined);
  await stopChildren();
}

async function verifyLivenessAndReadiness(origin) {
  const health = await fetch(`${origin}/health`);
  assertStatus(health, 200, "/health");
  const response = await fetch(`${origin}/ready`);
  assertStatus(response, 200, "/ready with services available");
  const readiness = await response.json();
  if (
    readiness.dependencies?.postgres !== "ok" ||
    readiness.dependencies?.redis !== "ok"
  ) {
    throw new Error(
      `/ready did not report both services healthy: ${JSON.stringify(readiness)}`,
    );
  }
}

async function verifyRedisOutageReadiness() {
  const port = await getFreePort();
  const appEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    SESSION_SECRET:
      process.env.SESSION_SECRET ??
      "qualification-session-secret-not-for-production",
    APP_ORIGIN: appOrigin,
    APP_BASE_URL: appOrigin,
    TEST_FIXTURE_ORIGIN: fixtureOrigin,
    TEST_FIXTURE_ADDRESS: process.env.TEST_FIXTURE_ADDRESS ?? "127.0.0.1",
    REDIS_URL: "redis://127.0.0.1:1",
    ALLOW_DEV_VERIFICATION_TOKEN: "true",
    SCHEDULER_INTERVAL_MS: "1000",
    FETCH_TIMEOUT_MS: "1000",
    FETCH_MAX_REDIRECTS: "0",
    FETCH_DOMAIN_COOLDOWN_MS: "250",
  };
  const child = startChild(
    "API with unavailable Redis",
    ["--import", "tsx", path.join(root, "src/server/api.ts")],
    appEnv,
  );
  try {
    await waitForHttp(`http://127.0.0.1:${port}/health`, 15_000);
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/ready`, {
      signal: AbortSignal.timeout(4_000),
    });
    const elapsedMs = Date.now() - startedAt;
    assertStatus(response, 503, "/ready with Redis unavailable");
    const result = await response.json();
    if (
      result.dependencies?.postgres !== "ok" ||
      result.dependencies?.redis !== "unavailable" ||
      elapsedMs >= 4_000
    ) {
      throw new Error(
        `Redis outage was not reported promptly and independently: ${JSON.stringify(result)} (${elapsedMs} ms).`,
      );
    }
    console.log(
      "Readiness failure path passed: PostgreSQL ok, Redis unavailable.",
    );
  } finally {
    await stopChild(child);
  }
}

async function verifySchedulerRequeuesDueMonitor(
  origin,
  cookie,
  monitorId,
  initialCount,
) {
  await pool.query(
    `UPDATE monitors
     SET last_checked_at = now() - interval '2 minutes',
         next_check_at = now() - interval '2 seconds'
     WHERE id = $1`,
    [monitorId],
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const list = await getJson(origin, "/api/monitors", cookie);
    const count = list.body.monitors.find(
      (monitor) => monitor.id === monitorId,
    )?.checkCount;
    if (Number(count) > Number(initialCount) + 1) {
      console.log(
        "Scheduler path passed: due database work was re-enqueued and processed.",
      );
      return;
    }
    await delay(250);
  }
  throw new Error("The running scheduler did not re-enqueue due monitor work.");
}

async function verifyWorkerRetry(origin, authenticated, id) {
  await setFixture({
    content: "Worker retry fixture content",
    failuresRemaining: 1,
  });
  const email = `qualification-retry-${id}@example.com`;
  createdEmails.add(email);
  const result = await postJson(origin, "/api/monitors", {
    ...authenticated,
    origin: appOrigin,
    body: {
      name: "Qualification retry fixture",
      url: `${fixtureOrigin}/flaky`,
      frequency: "daily",
    },
  });
  assertStatus(result.response, 201, "retry monitor creation");
  const monitorId = result.body.monitor.id;
  const baseline = await waitForMonitorSnapshot(
    origin,
    authenticated.cookie,
    monitorId,
    (snapshot) => snapshot?.content === "Worker retry fixture content",
    20_000,
  );
  if (!baseline)
    throw new Error(
      "The worker retry did not eventually persist its snapshot.",
    );
  const fixtureStatsUrl = new URL(fixtureControlUrl);
  fixtureStatsUrl.pathname = "/__stats";
  fixtureStatsUrl.search = "";
  const stats = await fetch(fixtureStatsUrl).then((response) =>
    response.json(),
  );
  if ((stats.requestsByPath?.["/flaky"] ?? 0) < 2)
    throw new Error(
      "The failed fetch was not retried by the Redis-backed worker.",
    );
  console.log(
    "Worker retry path passed: one transient fetch failure recovered on retry.",
  );
}

async function verifyWorkerFailurePersistence(origin, authenticated, id) {
  await setFixture({
    content: "Failure fixture",
    unsupportedContentType: false,
  });
  const email = `qualification-failure-${id}@example.com`;
  createdEmails.add(email);
  const result = await postJson(origin, "/api/monitors", {
    ...authenticated,
    origin: appOrigin,
    body: {
      name: "Qualification failure fixture",
      url: `${fixtureOrigin}/unsupported`,
      frequency: "daily",
    },
  });
  assertStatus(result.response, 201, "failure monitor creation");
  const monitorId = result.body.monitor.id;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await pool.query(
      `SELECT consecutive_failures, last_error_code FROM monitors WHERE id = $1`,
      [monitorId],
    );
    if (
      state.rows[0]?.consecutive_failures === 1 &&
      state.rows[0]?.last_error_code === "UNSUPPORTED_CONTENT_TYPE"
    ) {
      console.log(
        "Worker failure path passed: terminal failure state persisted to PostgreSQL.",
      );
      return;
    }
    await delay(250);
  }
  throw new Error(
    "The final worker failure was not persisted to the monitor row.",
  );
}

async function verifyMigrationBackedWorkflowRows(monitorId) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM snapshots WHERE monitor_id = $1) AS snapshots,
       (SELECT count(*)::int FROM changes WHERE monitor_id = $1) AS changes,
       (SELECT count(*)::int FROM notification_outbox o
        JOIN changes c ON c.id = o.change_id WHERE c.monitor_id = $1) AS outbox`,
    [monitorId],
  );
  if (
    (result.rows[0]?.snapshots ?? 0) < 3 ||
    (result.rows[0]?.changes ?? 0) !== 1 ||
    (result.rows[0]?.outbox ?? 0) !== 1
  ) {
    throw new Error(
      `Workflow persistence rows were incomplete: ${JSON.stringify(result.rows[0])}`,
    );
  }
}

async function waitForMonitorSnapshot(
  origin,
  cookie,
  monitorId,
  predicate,
  timeoutMs,
) {
  const deadline = Date.now() + timeoutMs;
  let lastDetails;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/monitors/${monitorId}`, {
      headers: { cookie },
    });
    if (response.ok) {
      lastDetails = await response.json();
      if (predicate(lastDetails.currentSnapshot, lastDetails))
        return lastDetails;
    }
    await delay(200);
  }
  return lastDetails && predicate(lastDetails.currentSnapshot, lastDetails)
    ? lastDetails
    : null;
}

async function waitForOutbox(monitorId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT o.status
       FROM notification_outbox o
       JOIN changes c ON c.id = o.change_id
       WHERE c.monitor_id = $1
       LIMIT 1`,
      [monitorId],
    );
    if (result.rows[0]) return result.rows[0];
    await delay(200);
  }
  return null;
}

async function setFixture(settings) {
  const response = await fetch(fixtureControlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!response.ok) throw new Error("Could not update the local HTTP fixture.");
}

async function createSession(origin) {
  const response = await fetch(`${origin}/api/auth/csrf`);
  assertStatus(response, 200, "CSRF bootstrap");
  const body = await response.json();
  const cookie = getSessionCookie(response.headers);
  if (!cookie || !body.csrfToken)
    throw new Error("The API did not establish a CSRF-protected session.");
  return { cookie, csrfToken: body.csrfToken };
}

async function postJson(
  origin,
  route,
  { cookie, csrfToken, origin: requestOrigin, body },
) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (cookie) headers.cookie = cookie;
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  if (requestOrigin) headers.origin = requestOrigin;
  const response = await fetch(`${origin}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    // An empty JSON response is not expected for these qualification paths.
  }
  return { response, body: result };
}

async function getJson(origin, route, cookie) {
  const response = await fetch(`${origin}${route}`, {
    headers: cookie ? { cookie } : {},
  });
  return { response, body: await response.json() };
}

function getSessionCookie(headers) {
  const setCookieValues =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie") ?? ""];
  const value = setCookieValues.find((item) => item.startsWith("wcm.sid="));
  return value?.split(";", 1)[0];
}

function assertStatus(response, expected, label) {
  if (response.status !== expected)
    throw new Error(
      `${label} returned ${response.status}; expected ${expected}.`,
    );
}

async function waitForApiReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      last = `${response.status} ${await response.text()}`;
      if (response.status === 200) {
        const body = JSON.parse(
          last.slice(last.indexOf("{") >= 0 ? last.indexOf("{") : 0),
        );
        if (body.status === "ready") return;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Application readiness did not pass: ${last}`);
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Wait for the local fixture to bind its port.
    }
    await delay(100);
  }
  throw new Error(`Local HTTP fixture did not become ready: ${url}`);
}

function startChild(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping && code !== 0)
      console.error(`${name} exited with ${code ?? signal}.`);
  });
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 8_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function stopChildren() {
  if (stopping) return;
  stopping = true;
  await Promise.all([...children].map(stopChild));
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a local test port.");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
