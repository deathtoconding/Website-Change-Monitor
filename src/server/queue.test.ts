import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fakeMonitorQueue } = vi.hoisted(() => ({
  fakeMonitorQueue: {
    getJob: vi.fn(),
    add: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("bullmq", () => ({
  Queue: class MockQueue {
    constructor(readonly name: string) {}

    getJob(...args: unknown[]) {
      return this.name === "monitor-checks"
        ? fakeMonitorQueue.getJob(...args)
        : Promise.resolve(undefined);
    }

    add(...args: unknown[]) {
      return this.name === "monitor-checks"
        ? fakeMonitorQueue.add(...args)
        : Promise.resolve(undefined);
    }
  },
}));

vi.mock("ioredis", () => ({
  Redis: class MockRedis {
    on() {
      return this;
    }

    duplicate() {
      return this;
    }
  },
}));

vi.mock("./logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

let enqueueMonitorCheck: (typeof import("./queue.js"))["enqueueMonitorCheck"];

beforeAll(async () => {
  ({ enqueueMonitorCheck } = await import("./queue.js"));
});

beforeEach(() => {
  fakeMonitorQueue.getJob.mockReset();
  fakeMonitorQueue.add.mockReset().mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

describe("enqueueMonitorCheck stale-job recovery", () => {
  const data = {
    monitorId: "monitor-1",
    userId: "user-1",
    requestId: "request-1",
    trigger: "scheduled" as const,
  };
  const scheduledAt = new Date(18_000_000);

  it("adds a scheduled check when no job exists for its minute slot", async () => {
    fakeMonitorQueue.getJob.mockResolvedValue(undefined);

    await enqueueMonitorCheck(data, scheduledAt);

    expect(fakeMonitorQueue.add).toHaveBeenCalledWith("check-monitor", data, {
      jobId: "monitor-monitor-1-18000000",
    });
  });

  it("uses the full due timestamp so a rescheduled check in the same minute gets a fresh ID", async () => {
    fakeMonitorQueue.getJob.mockResolvedValue(undefined);
    const rescheduledAt = new Date(scheduledAt.getTime() + 1);

    await enqueueMonitorCheck(data, rescheduledAt);

    expect(fakeMonitorQueue.add).toHaveBeenCalledWith("check-monitor", data, {
      jobId: `monitor-${data.monitorId}-${rescheduledAt.getTime()}`,
    });
  });

  it("leaves active and recently failed jobs untouched", async () => {
    const activeJob = {
      finishedOn: undefined,
      getState: vi.fn().mockResolvedValue("active"),
      remove: vi.fn(),
    };
    fakeMonitorQueue.getJob.mockResolvedValue(activeJob);

    await enqueueMonitorCheck(data, scheduledAt);

    expect(activeJob.remove).not.toHaveBeenCalled();
    expect(fakeMonitorQueue.add).not.toHaveBeenCalled();

    const recentFailedJob = {
      finishedOn: 380_001,
      getState: vi.fn().mockResolvedValue("failed"),
      remove: vi.fn(),
    };
    fakeMonitorQueue.getJob.mockResolvedValue(recentFailedJob);
    vi.spyOn(Date, "now").mockReturnValue(500_000);

    await enqueueMonitorCheck(data, scheduledAt);

    expect(recentFailedJob.remove).not.toHaveBeenCalled();
    expect(fakeMonitorQueue.add).not.toHaveBeenCalled();

    const completedJob = {
      finishedOn: 1,
      getState: vi.fn().mockResolvedValue("completed"),
      remove: vi.fn(),
    };
    fakeMonitorQueue.getJob.mockResolvedValue(completedJob);

    await enqueueMonitorCheck(data, scheduledAt);

    expect(completedJob.remove).not.toHaveBeenCalled();
    expect(fakeMonitorQueue.add).not.toHaveBeenCalled();
  });

  it("removes and re-adds a failed job after the persistence grace period", async () => {
    const staleFailedJob = {
      finishedOn: 379_999,
      getState: vi.fn().mockResolvedValue("failed"),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    fakeMonitorQueue.getJob.mockResolvedValue(staleFailedJob);
    vi.spyOn(Date, "now").mockReturnValue(500_000);

    await enqueueMonitorCheck(data, scheduledAt);

    expect(staleFailedJob.remove).toHaveBeenCalledOnce();
    expect(fakeMonitorQueue.add).toHaveBeenCalledWith("check-monitor", data, {
      jobId: "monitor-monitor-1-18000000",
    });
  });
});
