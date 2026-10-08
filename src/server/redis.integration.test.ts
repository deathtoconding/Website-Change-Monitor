import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createOrReuseCheckoutSession } from "./services/checkout-coordinator.js";

const redisUrl = process.env.REDIS_TEST_URL;
if (redisUrl) {
  process.env.REDIS_URL = redisUrl;
  process.env.FETCH_TIMEOUT_MS ??= "1000";
  process.env.FETCH_MAX_REDIRECTS ??= "0";
  process.env.FETCH_DOMAIN_COOLDOWN_MS ??= "250";
}

const queueResources: Array<{
  queue: Queue;
  worker: Worker;
  events: QueueEvents;
}> = [];
const integrationKeys = new Set<string>();
let appQueueModule: typeof import("./queue.js") | undefined;
let appRedis: Redis | undefined;

describe.skipIf(!redisUrl)("Redis 7 infrastructure integration", () => {
  beforeAll(async () => {
    appQueueModule = await import("./queue.js");
    appRedis = new Redis(redisUrl!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    await appRedis.connect();
    await appRedis.ping();
  });

  afterAll(async () => {
    for (const { worker, events, queue } of queueResources) {
      await worker.close().catch(() => undefined);
      await events.close().catch(() => undefined);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
    if (appRedis) {
      for (const key of integrationKeys)
        await appRedis.del(key).catch(() => undefined);
      await appRedis.quit().catch(() => appRedis?.disconnect());
    }
    if (appQueueModule) await appQueueModule.closeQueues();
  });

  it("executes BullMQ retries, persists failed jobs, and holds scheduled work until its delay", async () => {
    const queueName = `wcm-qualification-${randomUUID()}`;
    let retryAttempts = 0;
    let failedAttempts = 0;
    const worker = new Worker(
      queueName,
      async (job) => {
        if (job.name === "retry") {
          retryAttempts += 1;
          if (retryAttempts < 3) throw new Error("retry qualification failure");
          return { processed: true };
        }
        if (job.name === "always-fail") {
          failedAttempts += 1;
          throw new Error("terminal qualification failure");
        }
        return { processedAt: Date.now() };
      },
      { connection: new Redis(redisUrl!, { maxRetriesPerRequest: null }) },
    );
    const queue = new Queue(queueName, {
      connection: new Redis(redisUrl!, { maxRetriesPerRequest: null }),
    });
    const events = new QueueEvents(queueName, {
      connection: new Redis(redisUrl!, { maxRetriesPerRequest: null }),
    });
    queueResources.push({ queue, worker, events });
    await Promise.all([
      worker.waitUntilReady(),
      queue.waitUntilReady(),
      events.waitUntilReady(),
    ]);

    const retried = await queue.add(
      "retry",
      { work: "retry" },
      {
        attempts: 3,
        backoff: { type: "fixed", delay: 30 },
        removeOnComplete: false,
      },
    );
    await expect(retried.waitUntilFinished(events, 10_000)).resolves.toEqual({
      processed: true,
    });
    expect(retryAttempts).toBe(3);
    expect(await retried.getState()).toBe("completed");

    const terminal = await queue.add(
      "always-fail",
      { work: "fail" },
      {
        attempts: 2,
        backoff: { type: "fixed", delay: 25 },
        removeOnFail: false,
      },
    );
    await expect(terminal.waitUntilFinished(events, 10_000)).rejects.toThrow(
      "terminal qualification failure",
    );
    expect(failedAttempts).toBe(2);
    expect(await terminal.getState()).toBe("failed");
    const persistedTerminal = await queue.getJob(terminal.id!);
    expect(persistedTerminal?.attemptsMade).toBe(2);

    const scheduledAt = Date.now();
    const delayed = await queue.add(
      "scheduled",
      { work: "delayed" },
      { delay: 1_000, removeOnComplete: false },
    );
    expect(await delayed.getState()).toBe("delayed");
    const delayedResult = await delayed.waitUntilFinished(events, 10_000);
    expect(delayedResult.processedAt - scheduledAt).toBeGreaterThanOrEqual(800);
  }, 30_000);

  it("uses the application queue API to enqueue idempotent monitor checks", async () => {
    const monitorId = randomUUID();
    const scheduledAt = new Date(Date.now() + 1_000);
    const data = {
      monitorId,
      userId: randomUUID(),
      requestId: randomUUID(),
      trigger: "scheduled" as const,
    };
    const jobId = `monitor-${monitorId}-${scheduledAt.getTime()}`;

    await appQueueModule!.enqueueMonitorCheck(data, scheduledAt);
    await appQueueModule!.enqueueMonitorCheck(data, scheduledAt);
    const job = await appQueueModule!.monitorQueue.getJob(jobId);

    expect(job?.data).toEqual(data);
    expect(await appQueueModule!.monitorQueue.getJob(jobId)).toBeTruthy();
    await job?.remove();
  });

  it("enforces Redis domain locks, cooldown expiry, and crash-lock recovery", async () => {
    const domain = `lock-${randomUUID()}.example.com`;
    const domainKey = `wcm:domain:${domain}`;
    integrationKeys.add(domainKey);
    const release = await appQueueModule!.acquireDomainSlot(domain, 250);
    await expect(
      appQueueModule!.acquireDomainSlot(domain, 250),
    ).rejects.toMatchObject({
      code: "DOMAIN_RATE_LIMIT",
    });
    await release();
    expect(await appRedis!.get(domainKey)).toBe("cooldown");
    await expect(
      appQueueModule!.acquireDomainSlot(domain, 250),
    ).rejects.toMatchObject({
      code: "DOMAIN_RATE_LIMIT",
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const afterCooldown = await appQueueModule!.acquireDomainSlot(domain, 250);
    await afterCooldown();

    const crashedDomain = `crashed-${randomUUID()}.example.com`;
    const crashedKey = `wcm:domain:${crashedDomain}`;
    integrationKeys.add(crashedKey);
    await appQueueModule!.acquireDomainSlot(crashedDomain, 250);
    const lockTtl = await appRedis!.pttl(crashedKey);
    expect(lockTtl).toBeGreaterThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, lockTtl + 100));
    const recovered = await appQueueModule!.acquireDomainSlot(
      crashedDomain,
      250,
    );
    await recovered();
  }, 15_000);

  it("coordinates concurrent checkout creation with a real Redis lease", async () => {
    const userId = randomUUID();
    const session = {
      id: `cs_qualification_${randomUUID()}`,
      mode: "subscription",
      status: "open",
      url: `https://checkout.stripe.com/c/pay/${randomUUID()}`,
      customer: `cus_qualification_${randomUUID()}`,
      client_reference_id: userId,
      metadata: { userId, plan: "starter" },
    } as unknown as Stripe.Checkout.Session;
    const openSessions: Stripe.Checkout.Session[] = [];
    const createSession = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      openSessions.push(session);
      return session;
    };
    const stripe = {
      customers: {
        create: async () => ({ id: session.customer as string }),
      },
      checkout: {
        sessions: {
          list: async ({ status }: { status: string }) => ({
            data: status === "open" ? [...openSessions] : [],
          }),
          create: createSession,
          expire: async () => undefined,
          retrieve: async () => session,
        },
      },
      subscriptions: { retrieve: async () => ({ status: "active" }) },
    } as unknown as Stripe;
    let customerId: string | null = null;
    const input = {
      redis: appRedis!,
      stripe,
      user: {
        id: userId,
        email: `redis-checkout-${userId}@example.com`,
        stripeCustomerId: null,
      },
      plan: "starter" as const,
      price: "price_qualification_starter",
      appBaseUrl: "http://qualification.example.com",
      getEffectivePlan: async () => "free" as const,
      saveStripeCustomerId: async (_id: string, nextCustomerId: string) => {
        customerId = nextCustomerId;
      },
    };

    const [first, second] = await Promise.all([
      createOrReuseCheckoutSession({ ...input, requestId: randomUUID() }),
      createOrReuseCheckoutSession({ ...input, requestId: randomUUID() }),
    ]);

    expect(first.id).toBe(session.id);
    expect(second.id).toBe(first.id);
    expect(openSessions).toHaveLength(1);
    expect(customerId).toBe(session.customer);
    expect(await appRedis!.get(`wcm:checkout-lock:${userId}`)).toBeNull();
  }, 10_000);

  it("returns bounded unavailable readiness for a real Redis connection failure", async () => {
    const { checkReadiness } = await import("./readiness.js");
    const unavailableRedis = new Redis("redis://127.0.0.1:1", {
      connectTimeout: 100,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    unavailableRedis.on("error", () => undefined);
    try {
      const readiness = await checkReadiness(
        {
          postgres: async () => undefined,
          redis: () => unavailableRedis.ping(),
        },
        250,
      );
      expect(readiness).toEqual({
        status: "not_ready",
        dependencies: { postgres: "ok", redis: "unavailable" },
      });
    } finally {
      unavailableRedis.disconnect();
    }
  }, 5_000);
});
