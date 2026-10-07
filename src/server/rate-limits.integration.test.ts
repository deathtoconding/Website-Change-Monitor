import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";

const redisUrl = process.env.REDIS_TEST_URL;
const workers = new Set<ChildProcess>();

describe.skipIf(!redisUrl)("Redis-backed authentication rate limits", () => {
  afterAll(async () => {
    await Promise.all([...workers].map(stopWorker));
    workers.clear();
  });

  it("shares the 10-per-15-minute authentication counter across processes", async () => {
    await verifySharedCounter("auth-attempt", 10);
  }, 30_000);

  it("shares the 5-per-hour reset counter across processes", async () => {
    await verifySharedCounter("reset-attempt", 5);
  }, 30_000);
});

async function verifySharedCounter(
  route: "auth-attempt" | "reset-attempt",
  allowedRequests: number,
): Promise<void> {
  const namespace = `integration-${randomUUID()}`;
  const firstPort = await getFreePort();
  let secondPort = await getFreePort();
  while (secondPort === firstPort) secondPort = await getFreePort();

  const first = startWorker(firstPort, namespace);
  const second = startWorker(secondPort, namespace);
  const pair = [first, second];
  pair.forEach(({ process: child }) => workers.add(child));
  const cleanupRedis = new Redis(redisUrl!, {
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  try {
    await Promise.all(pair.map(({ ready }) => ready));
    const results: number[] = [];
    for (let attempt = 0; attempt <= allowedRequests; attempt += 1) {
      const port = attempt % 2 === 0 ? firstPort : secondPort;
      const response = await fetch(`http://127.0.0.1:${port}/${route}`, {
        method: "POST",
      });
      results.push(response.status);
    }

    expect(results.slice(0, allowedRequests)).toEqual(
      Array<number>(allowedRequests).fill(204),
    );
    expect(results[allowedRequests]).toBe(429);
  } finally {
    await Promise.all(pair.map(({ process: child }) => stopWorker(child)));
    pair.forEach(({ process: child }) => workers.delete(child));
    const keys = await cleanupRedis
      .keys(`wcm:rate-limit:${namespace}:*`)
      .catch(() => []);
    if (keys.length) await cleanupRedis.del(...keys).catch(() => undefined);
    await cleanupRedis.quit();
  }
}

function startWorker(
  port: number,
  namespace: string,
): { process: ChildProcess; ready: Promise<void> } {
  const workerPath = fileURLToPath(
    new URL("../../scripts/auth-rate-limit-worker.mjs", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, String(port), namespace],
    {
      cwd: process.cwd(),
      env: { ...process.env, REDIS_TEST_URL: redisUrl },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Rate-limit worker did not start: ${output}`));
    }, 10_000);
    const checkReady = () => {
      if (output.includes("READY")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout?.on("data", checkReady);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Rate-limit worker exited (${code}): ${output}`));
    });
    checkReady();
  });

  return { process: child, ready };
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a local test port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}
