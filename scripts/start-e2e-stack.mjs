import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureOrigin =
  process.env.TEST_FIXTURE_ORIGIN ?? "http://fixture.test:18088";
const apiPort = Number(process.env.QUALIFICATION_API_PORT ?? 4_000);
const webPort = Number(process.env.QUALIFICATION_WEB_PORT ?? 3_000);
const fixturePort = Number(process.env.FIXTURE_PORT ?? 18_088);
const processes = [];
let stopping = false;
let resolveUnexpectedExit;
const unexpectedExit = new Promise((resolve) => {
  resolveUnexpectedExit = resolve;
});

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

try {
  const runtimeEnv = {
    ...process.env,
    NODE_ENV: "test",
    SESSION_SECRET:
      process.env.SESSION_SECRET ??
      "qualification-session-secret-not-for-production",
    APP_ORIGIN: `http://127.0.0.1:${webPort}`,
    APP_BASE_URL: `http://127.0.0.1:${webPort}`,
    TEST_FIXTURE_ORIGIN: fixtureOrigin,
    TEST_FIXTURE_ADDRESS: process.env.TEST_FIXTURE_ADDRESS ?? "127.0.0.1",
    ALLOW_DEV_VERIFICATION_TOKEN: "true",
    SCHEDULER_INTERVAL_MS: "1000",
    FETCH_TIMEOUT_MS: "1000",
    FETCH_MAX_REDIRECTS: "0",
    FETCH_DOMAIN_COOLDOWN_MS: "250",
  };

  start(
    "qualification HTTP fixture",
    process.execPath,
    [path.join(root, "scripts/e2e/http-fixture.mjs")],
    { ...runtimeEnv, FIXTURE_PORT: String(fixturePort) },
  );
  await waitForHttp(`http://127.0.0.1:${fixturePort}/__health`, {
    timeoutMs: 10_000,
  });

  start(
    "API",
    process.execPath,
    ["--import", "tsx", path.join(root, "src/server/api.ts")],
    { ...runtimeEnv, PORT: String(apiPort) },
  );
  await waitForReadiness(`http://127.0.0.1:${apiPort}/ready`, 45_000);

  start(
    "worker",
    process.execPath,
    ["--import", "tsx", path.join(root, "src/server/worker.ts")],
    runtimeEnv,
  );
  start(
    "scheduler",
    process.execPath,
    ["--import", "tsx", path.join(root, "src/server/scheduler.ts")],
    runtimeEnv,
  );

  const nextCli = path.join(root, "node_modules/next/dist/bin/next");
  start(
    "Next.js web",
    process.execPath,
    [nextCli, "start", "--hostname", "0.0.0.0", "--port", String(webPort)],
    {
      ...process.env,
      NODE_ENV: "production",
      API_INTERNAL_ORIGIN: `http://127.0.0.1:${apiPort}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  );
  console.log("Browser qualification application stack started.");

  const outcome = await Promise.race([
    unexpectedExit,
    new Promise((resolve) => {
      process.once("SIGINT", () => resolve({ signal: "SIGINT" }));
      process.once("SIGTERM", () => resolve({ signal: "SIGTERM" }));
    }),
  ]);
  if (outcome && !outcome.signal) {
    process.exitCode = 1;
    console.error(
      `${outcome.name} exited unexpectedly (${outcome.code ?? outcome.signal}).`,
    );
  }
} catch (error) {
  process.exitCode = 1;
  console.error("Could not start the browser qualification stack:", error);
} finally {
  await shutdown();
}

function start(name, executable, args, env) {
  const child = spawn(executable, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  const entry = { name, child };
  processes.push(entry);
  child.once("error", (error) => {
    if (stopping) return;
    resolveUnexpectedExit({ name, code: null, signal: error.message });
  });
  child.once("exit", (code, signal) => {
    if (stopping) return;
    resolveUnexpectedExit({ name, code, signal });
  });
}

async function waitForReadiness(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = "no response";
  while (Date.now() < deadline) {
    const childExited = await checkForUnexpectedExit();
    if (childExited)
      throw new Error(`${childExited.name} exited during startup.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      lastResponse = `${response.status} ${await response.text()}`;
      if (response.status === 200) {
        const result = JSON.parse(
          lastResponse.slice(
            lastResponse.indexOf("{") >= 0 ? lastResponse.indexOf("{") : 0,
          ),
        );
        if (result.status === "ready") return;
      }
    } catch (error) {
      lastResponse = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`API readiness did not pass: ${lastResponse}`);
}

async function waitForHttp(url, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The fixture process may need a short startup window.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The qualification fixture did not become ready at ${url}.`);
}

async function checkForUnexpectedExit() {
  return Promise.race([
    unexpectedExit,
    new Promise((resolve) => setTimeout(() => resolve(null), 0)),
  ]);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  const pending = processes.filter(({ child }) => child.exitCode === null);
  for (const { child } of pending) child.kill("SIGTERM");
  await Promise.all(
    pending.map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 8_000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        }),
    ),
  );
}
