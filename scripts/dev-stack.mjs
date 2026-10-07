import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import process from "node:process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = new Set();
let shuttingDown = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function waitForTcp(host, port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${host}:${port}.`);
}

function stopChildren(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

try {
  const compose = await run("docker", [
    "compose",
    "-f",
    "docker-compose.dev.yml",
    "up",
    "-d",
    "postgres",
    "redis",
  ]);
  if (compose.code !== 0)
    throw new Error("Could not start the local PostgreSQL/Redis containers.");
  await Promise.all([
    waitForTcp("127.0.0.1", 5432),
    waitForTcp("127.0.0.1", 6379),
  ]);
  const migration = await run(npm, ["run", "db:migrate"]);
  if (migration.code !== 0) throw new Error("Database migrations failed.");

  const scripts = ["dev:api", "dev:worker", "dev:scheduler", "dev"];
  for (const script of scripts) {
    const child = spawn(npm, ["run", script], { stdio: "inherit" });
    children.add(child);
    child.once("error", (error) => {
      console.error(error);
      stopChildren();
    });
    child.once("close", (code) => {
      children.delete(child);
      if (!shuttingDown && code !== 0) {
        console.error(`${script} exited with code ${code ?? "unknown"}.`);
        stopChildren();
        process.exitCode = code ?? 1;
      }
    });
  }
  console.log(
    "\nLocal stack starting: Next.js on :3000, API on :4000, PostgreSQL on :5432, Redis on :6379.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stopChildren();
  process.exitCode = 1;
}
