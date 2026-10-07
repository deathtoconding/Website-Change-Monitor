import Stripe from "stripe";
import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { createOrReuseCheckoutSession } from "./checkout-coordinator.js";

describe("checkout session concurrency coordination", () => {
  it("reuses one pending Stripe session for overlapping requests from the same user", async () => {
    const locks = new Map<string, string>();
    const setLock = vi.fn(async (key: string, token: string) => {
      if (locks.has(key)) return null;
      locks.set(key, token);
      return "OK";
    });
    const redis = {
      set: setLock,
      eval: vi.fn(
        async (
          _script: string,
          _keyCount: number,
          key: string,
          token: string,
        ) => {
          if (locks.get(key) !== token) return 0;
          locks.delete(key);
          return 1;
        },
      ),
    } as unknown as Pick<Redis, "set" | "eval">;

    const openSessions: Stripe.Checkout.Session[] = [];
    const session = {
      id: "cs_pending_once",
      mode: "subscription",
      status: "open",
      url: "https://checkout.stripe.com/c/pay/cs_pending_once",
      customer: "cus_user_1",
      client_reference_id: "user-1",
      metadata: { userId: "user-1", plan: "starter" },
    } as unknown as Stripe.Checkout.Session;
    const createCheckoutSession = vi.fn(async () => {
      // Hold the first caller inside Stripe long enough for the second
      // caller to contend on the shared per-user lock.
      await new Promise((resolve) => setTimeout(resolve, 125));
      openSessions.push(session);
      return session;
    });
    const stripe = {
      customers: {
        create: vi.fn().mockResolvedValue({ id: "cus_user_1" }),
      },
      checkout: {
        sessions: {
          list: vi.fn(async ({ status }: { status: string }) => ({
            data: status === "open" ? [...openSessions] : [],
          })),
          create: createCheckoutSession,
          expire: vi.fn(),
          retrieve: vi.fn(),
        },
      },
      subscriptions: { retrieve: vi.fn() },
    } as unknown as Stripe;
    const getEffectivePlan = vi.fn().mockResolvedValue("free");
    const saveStripeCustomerId = vi.fn().mockResolvedValue(undefined);
    const commonInput = {
      redis,
      stripe,
      user: {
        id: "user-1",
        email: "person@example.test",
        stripeCustomerId: null,
      },
      plan: "starter" as const,
      price: "price_starter",
      appBaseUrl: "https://watchtower.example.test",
      getEffectivePlan,
      saveStripeCustomerId,
    };

    const [first, second] = await Promise.all([
      createOrReuseCheckoutSession({ ...commonInput, requestId: "request-1" }),
      createOrReuseCheckoutSession({ ...commonInput, requestId: "request-2" }),
    ]);

    expect(first.id).toBe("cs_pending_once");
    expect(second.id).toBe(first.id);
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer: "cus_user_1",
        client_reference_id: "user-1",
      }),
      { idempotencyKey: "wcm-checkout-user-1-starter-request-1" },
    );
    expect(stripe.customers.create).toHaveBeenCalledWith(
      {
        email: "person@example.test",
        metadata: { userId: "user-1" },
      },
      { idempotencyKey: "wcm-customer-user-1" },
    );
    expect(stripe.checkout.sessions.list).toHaveBeenCalledWith({
      customer: "cus_user_1",
      status: "open",
      limit: 100,
    });
    expect(setLock.mock.calls.length).toBeGreaterThan(2);
  }, 10_000);
});
