import { UnrecoverableError, Worker, type Job } from "bullmq";
import { env } from "./config.js";
import { closeDatabase } from "./db/index.js";
import { logger } from "./logger.js";
import { closeQueues, redis, type MonitorJobData } from "./queue.js";
import {
  executeMonitorCheck,
  recordMonitorFailure,
} from "./services/monitor-engine.js";
import {
  notificationWorker,
  systemNotificationWorker,
} from "./services/notification-worker.js";
import { FetchError } from "./services/http-fetcher.js";

const retryDelays = [30_000, 2 * 60_000, 10 * 60_000];

const monitorWorker = new Worker<MonitorJobData>(
  "monitor-checks",
  runMonitorJob,
  {
    connection: redis.duplicate(),
    concurrency: env.workerConcurrency,
    settings: {
      backoffStrategy: (attemptsMade, type) =>
        type === "wcm-exponential"
          ? (retryDelays[attemptsMade - 1] ?? 10 * 60_000)
          : -1,
    },
  },
);

monitorWorker.on("completed", (job, outcome) => {
  logger.info(
    {
      requestId: job.data.requestId,
      jobId: job.id,
      monitorId: job.data.monitorId,
      userId: job.data.userId,
      status: outcome.status,
    },
    "Monitor job completed",
  );
});

monitorWorker.on("failed", (job, error) => {
  if (!job) return;
  const finalAttempt =
    error instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? 1);
  logger.error(
    {
      requestId: job.data.requestId,
      jobId: job.id,
      monitorId: job.data.monitorId,
      userId: job.data.userId,
      status: finalAttempt ? "failed" : "retrying",
      errorCode: getErrorCode(error),
    },
    "Monitor job attempt failed",
  );
  if (finalAttempt) {
    void recordMonitorFailure(job.data, error).catch(() => {
      logger.error(
        {
          requestId: job.data.requestId,
          jobId: job.id,
          monitorId: job.data.monitorId,
          errorCode: "MONITOR_FAILURE_UPDATE_FAILED",
        },
        "Could not persist monitor failure",
      );
    });
  }
});

monitorWorker.on("error", (error) => {
  logger.error(
    { errorCode: "MONITOR_WORKER_ERROR", err: error },
    "Monitor worker error",
  );
});

async function runMonitorJob(job: Job<MonitorJobData>) {
  try {
    return await executeMonitorCheck(job.data);
  } catch (error) {
    if (error instanceof FetchError && !error.retryable) {
      const permanent = new UnrecoverableError(error.message);
      Object.assign(permanent, { code: error.code });
      throw permanent;
    }
    throw error;
  }
}

function getErrorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "CHECK_FAILED";
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down worker processes");
  await Promise.allSettled([
    monitorWorker.close(),
    notificationWorker.close(),
    systemNotificationWorker.close(),
  ]);
  await closeQueues();
  await closeDatabase();
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

logger.info(
  { concurrency: env.workerConcurrency },
  "Monitor and notification workers are ready",
);
