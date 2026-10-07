import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type Stripe from "stripe";
import type { Redis } from "ioredis";
import { getSubscriptionPeriodEnd } from "../billing-utils.js";
import { logger } from "../logger.js";
import type { Plan } from "./plan-limits.js";

const CHECKOUT_LOCK_TTL_MS = 180_000;
const CHECKOUT_LOCK_RENEW_INTERVAL_MS = 60_000;
const CHECKOUT_LOCK_WAIT_MS = 5_000;
const CHECKOUT_LOCK_RETRY_MS = 50;

const RELEASE_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

type LockRedis = Pick<Redis, "set" | "eval">;

type CheckoutPlan = Exclude<Plan, "free">;

export class CheckoutLockBusyError extends Error {
  readonly code = "CHECKOUT_IN_PROGRESS";

  constructor() {
    super("A checkout is already starting. Please retry in a moment.");
    this.name = "CheckoutLockBusyError";
  }
}

export class CheckoutCoordinationUnavailableError extends Error {
  readonly code = "CHECKOUT_COORDINATION_UNAVAILABLE";

  constructor() {
    super("Checkout could not be safely coordinated. Please retry shortly.");
    this.name = "CheckoutCoordinationUnavailableError";
  }
}

export class PaidSubscriptionExistsError extends Error {
  readonly code = "SUBSCRIPTION_ALREADY_ACTIVE";

  constructor() {
    super("You already have a paid plan. Use the billing portal to manage it.");
    this.name = "PaidSubscriptionExistsError";
  }
}

export class CheckoutProcessingError extends Error {
  readonly code = "CHECKOUT_PROCESSING";

  constructor() {
    super(
      "A recent checkout is still processing. Refresh your billing status and try again shortly.",
    );
    this.name = "CheckoutProcessingError";
  }
}

export async function createOrReuseCheckoutSession(input: {
  redis: LockRedis;
  stripe: Stripe;
  user: { id: string; email: string; stripeCustomerId: string | null };
  plan: CheckoutPlan;
  price: string;
  requestId: string;
  appBaseUrl: string;
  getEffectivePlan: (userId: string) => Promise<Plan>;
  saveStripeCustomerId: (userId: string, customerId: string) => Promise<void>;
}): Promise<Stripe.Checkout.Session> {
  return withCheckoutLock(
    input.redis,
    input.user.id,
    async (assertLockHeld) => {
      assertLockHeld();
      if ((await input.getEffectivePlan(input.user.id)) !== "free")
        throw new PaidSubscriptionExistsError();
      assertLockHeld();

      let customerId = input.user.stripeCustomerId;
      if (!customerId) {
        const customer = await input.stripe.customers.create(
          {
            email: input.user.email,
            metadata: { userId: input.user.id },
          },
          { idempotencyKey: `wcm-customer-${input.user.id}` },
        );
        assertLockHeld();
        customerId = customer.id;
        await input.saveStripeCustomerId(input.user.id, customerId);
        assertLockHeld();
      }

      const openSessions = await input.stripe.checkout.sessions.list({
        customer: customerId,
        status: "open",
        limit: 100,
      });
      assertLockHeld();
      const ownedOpenSessions = openSessions.data.filter(
        (session) =>
          session.mode === "subscription" &&
          isSessionForUser(session, input.user.id),
      );
      const reusableSession = ownedOpenSessions.find(
        (session) => session.metadata?.plan === input.plan && session.url,
      );

      if (reusableSession) {
        await expireOtherOpenSessions(
          input.stripe,
          ownedOpenSessions.filter(
            (session) => session.id !== reusableSession.id,
          ),
          assertLockHeld,
        );
        assertLockHeld();
        return reusableSession;
      }

      await assertNoCompletedCheckoutIsProcessing(
        input.stripe,
        customerId,
        input.user.id,
        assertLockHeld,
      );
      await expireOtherOpenSessions(
        input.stripe,
        ownedOpenSessions,
        assertLockHeld,
      );

      assertLockHeld();
      const session = await input.stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: customerId,
          client_reference_id: input.user.id,
          line_items: [{ price: input.price, quantity: 1 }],
          allow_promotion_codes: true,
          success_url: `${input.appBaseUrl}/settings?billing=success`,
          cancel_url: `${input.appBaseUrl}/settings?billing=cancelled`,
          metadata: { userId: input.user.id, plan: input.plan },
          subscription_data: {
            metadata: { userId: input.user.id, plan: input.plan },
          },
        },
        {
          idempotencyKey: `wcm-checkout-${input.user.id}-${input.plan}-${input.requestId}`,
        },
      );
      assertLockHeld();
      return session;
    },
  );
}

async function withCheckoutLock<T>(
  redis: LockRedis,
  userId: string,
  operation: (assertLockHeld: () => void) => Promise<T>,
): Promise<T> {
  const key = `wcm:checkout-lock:${userId}`;
  const token = randomUUID();
  const deadline = Date.now() + CHECKOUT_LOCK_WAIT_MS;
  let acquired = false;

  do {
    const result = await redis.set(
      key,
      token,
      "PX",
      CHECKOUT_LOCK_TTL_MS,
      "NX",
    );
    if (result === "OK") {
      acquired = true;
      break;
    }
    if (Date.now() >= deadline) break;
    await delay(CHECKOUT_LOCK_RETRY_MS);
  } while (Date.now() < deadline);

  if (!acquired) throw new CheckoutLockBusyError();

  let leaseLost = false;
  let renewalPromise: Promise<void> | undefined;
  const assertLockHeld = () => {
    if (leaseLost) throw new CheckoutCoordinationUnavailableError();
  };
  const renewLease = async () => {
    try {
      const renewed = await redis.eval(
        RENEW_LOCK_SCRIPT,
        1,
        key,
        token,
        String(CHECKOUT_LOCK_TTL_MS),
      );
      if (Number(renewed) !== 1) leaseLost = true;
    } catch {
      leaseLost = true;
    }
    if (leaseLost) {
      logger.warn(
        { errorCode: "CHECKOUT_LOCK_RENEWAL_FAILED" },
        "Checkout coordination lease was lost; leaving it to expire",
      );
    }
  };
  const renewalTimer = setInterval(() => {
    if (leaseLost || renewalPromise) return;
    renewalPromise = renewLease().finally(() => {
      renewalPromise = undefined;
    });
  }, CHECKOUT_LOCK_RENEW_INTERVAL_MS);
  renewalTimer.unref();

  try {
    return await operation(assertLockHeld);
  } finally {
    clearInterval(renewalTimer);
    if (renewalPromise) await renewalPromise;
    if (!leaseLost) {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token).catch(() => {
        // A finite lease recovers automatically if release fails or this process dies.
        logger.warn(
          { errorCode: "CHECKOUT_LOCK_RELEASE_FAILED" },
          "Checkout lock will expire automatically",
        );
      });
    }
  }
}

async function expireOtherOpenSessions(
  stripe: Stripe,
  sessions: Stripe.Checkout.Session[],
  assertLockHeld: () => void,
): Promise<void> {
  for (const session of sessions) {
    assertLockHeld();
    let expirationFailed = false;
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch {
      expirationFailed = true;
    }
    assertLockHeld();
    if (!expirationFailed) continue;

    const current = await stripe.checkout.sessions.retrieve(session.id);
    assertLockHeld();
    if (current.status === "complete") throw new CheckoutProcessingError();
    if (current.status === "open")
      throw new Error("Could not close an older checkout session.");
  }
}

async function assertNoCompletedCheckoutIsProcessing(
  stripe: Stripe,
  customerId: string,
  userId: string,
  assertLockHeld: () => void,
): Promise<void> {
  const completedSessions = await stripe.checkout.sessions.list({
    customer: customerId,
    status: "complete",
    limit: 100,
  });
  assertLockHeld();

  for (const session of completedSessions.data) {
    assertLockHeld();
    if (session.mode !== "subscription" || !isSessionForUser(session, userId))
      continue;

    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id;
    if (!subscriptionId) throw new CheckoutProcessingError();

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    assertLockHeld();
    const periodEnd = getSubscriptionPeriodEnd(subscription);
    const activeThroughPeriodEnd =
      subscription.status === "canceled" &&
      periodEnd !== null &&
      periodEnd * 1_000 > Date.now();
    if (
      activeThroughPeriodEnd ||
      !["canceled", "incomplete_expired"].includes(subscription.status)
    )
      throw new CheckoutProcessingError();
  }
}

function isSessionForUser(
  session: Stripe.Checkout.Session,
  userId: string,
): boolean {
  return (
    session.client_reference_id === userId ||
    session.metadata?.userId === userId
  );
}
