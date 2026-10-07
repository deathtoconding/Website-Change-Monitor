import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { Request, RequestHandler, Response } from "express";
import type { Redis } from "ioredis";
import { db } from "../db/index.js";
import { stripeEvents, subscriptions, users } from "../db/schema.js";
import { asyncRoute, requireAuth, requireCsrf } from "../middleware.js";
import { env } from "../config.js";
import { logger } from "../logger.js";
import {
  getInvoiceSubscriptionId,
  getSubscriptionPeriodEnd,
} from "../billing-utils.js";
import { getEffectivePlan, type Plan } from "../services/plan-limits.js";
import {
  CheckoutCoordinationUnavailableError,
  CheckoutLockBusyError,
  CheckoutProcessingError,
  createOrReuseCheckoutSession,
  PaidSubscriptionExistsError,
} from "../services/checkout-coordinator.js";
import { redisControl } from "../queue.js";

export interface BillingRouterDependencies {
  getStripe?: () => Stripe | null;
  getEffectivePlan?: (userId: string) => Promise<Plan>;
  saveStripeCustomerId?: (userId: string, customerId: string) => Promise<void>;
  checkoutRedis?: Pick<Redis, "set" | "eval">;
  requireAuth?: RequestHandler;
  requireCsrf?: RequestHandler;
}

function getStripe(): Stripe | null {
  return env.stripeSecretKey
    ? new Stripe(env.stripeSecretKey, { timeout: 15_000, maxNetworkRetries: 1 })
    : null;
}

export function createBillingRouter(
  dependencies: BillingRouterDependencies = {},
): ReturnType<typeof Router> {
  const router = Router();
  const resolveStripe = dependencies.getStripe ?? getStripe;
  const resolveEffectivePlan =
    dependencies.getEffectivePlan ?? getEffectivePlan;
  const saveStripeCustomerId =
    dependencies.saveStripeCustomerId ??
    (async (userId: string, customerId: string) => {
      await db
        .update(users)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(users.id, userId));
    });
  const checkoutRedis = dependencies.checkoutRedis ?? redisControl;
  const authMiddleware = dependencies.requireAuth ?? requireAuth;
  const csrfMiddleware = dependencies.requireCsrf ?? requireCsrf;

  router.post(
    "/billing/checkout",
    authMiddleware,
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      const parsed = z
        .object({ plan: z.enum(["starter", "business"]) })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Choose a valid paid plan." });
        return;
      }
      const stripe = resolveStripe();
      if (!stripe) {
        res
          .status(503)
          .json({ error: "Billing is not configured on this deployment." });
        return;
      }
      const plan = parsed.data.plan;
      const price =
        plan === "starter" ? env.stripePriceStarter : env.stripePriceBusiness;
      if (!price) {
        res.status(503).json({ error: "The selected plan is not configured." });
        return;
      }

      const user = req.authUser!;
      let session: Stripe.Checkout.Session;
      try {
        session = await createOrReuseCheckoutSession({
          redis: checkoutRedis,
          stripe,
          user,
          plan,
          price,
          requestId: req.requestId ?? randomUUID(),
          appBaseUrl: env.appBaseUrl,
          getEffectivePlan: resolveEffectivePlan,
          saveStripeCustomerId,
        });
      } catch (error) {
        if (error instanceof CheckoutCoordinationUnavailableError) {
          res.setHeader("Retry-After", "2");
          res.status(503).json({ error: error.message, code: error.code });
          return;
        }
        if (error instanceof CheckoutLockBusyError) {
          res.setHeader("Retry-After", "2");
          res.status(409).json({ error: error.message, code: error.code });
          return;
        }
        if (error instanceof PaidSubscriptionExistsError) {
          res.status(409).json({ error: error.message, code: error.code });
          return;
        }
        if (error instanceof CheckoutProcessingError) {
          res.status(409).json({ error: error.message, code: error.code });
          return;
        }
        throw error;
      }

      if (!session.url) {
        res.status(502).json({ error: "Checkout could not be started." });
        return;
      }
      res.json({ url: session.url });
    }),
  );

  router.post(
    "/billing/portal",
    authMiddleware,
    csrfMiddleware,
    asyncRoute(async (req, res) => {
      const stripe = resolveStripe();
      if (!stripe) {
        res
          .status(503)
          .json({ error: "Billing is not configured on this deployment." });
        return;
      }
      const user = req.authUser!;
      if (!user.stripeCustomerId) {
        res
          .status(409)
          .json({ error: "No billing account is associated with this user." });
        return;
      }
      const portal = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${env.appBaseUrl}/settings`,
      });
      res.json({ url: portal.url });
    }),
  );

  return router;
}

export const billingRouter = createBillingRouter();

export async function handleStripeWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const stripe = getStripe();
  if (!stripe || !env.stripeWebhookSecret) {
    res.status(503).json({ error: "Stripe webhooks are not configured." });
    return;
  }
  const signature = req.header("stripe-signature");
  if (!signature || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Invalid webhook request." });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      env.stripeWebhookSecret,
    );
  } catch {
    res.status(400).json({ error: "Invalid webhook signature." });
    return;
  }

  let checkoutSubscription: Stripe.Subscription | null = null;
  if (event.type === "checkout.session.completed") {
    const checkout = event.data.object as Stripe.Checkout.Session;
    const subscriptionId =
      typeof checkout.subscription === "string"
        ? checkout.subscription
        : checkout.subscription?.id;
    if (subscriptionId)
      checkoutSubscription =
        await stripe.subscriptions.retrieve(subscriptionId);
  }

  try {
    const wasProcessed = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .insert(stripeEvents)
        .values({ id: event.id, type: event.type })
        .onConflictDoNothing()
        .returning({ id: stripeEvents.id });
      if (!claimed) return false;

      const now = new Date();
      if (event.type === "checkout.session.completed") {
        const checkout = event.data.object as Stripe.Checkout.Session;
        const userId =
          checkout.metadata?.userId ?? checkout.client_reference_id;
        const customerId =
          typeof checkout.customer === "string"
            ? checkout.customer
            : checkout.customer?.id;
        if (userId && customerId) {
          await tx
            .update(users)
            .set({ stripeCustomerId: customerId, updatedAt: now })
            .where(eq(users.id, userId));
        }
        if (checkoutSubscription)
          await syncSubscription(tx, checkoutSubscription, now);
      } else if (
        event.type === "customer.subscription.created" ||
        event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted"
      ) {
        await syncSubscription(
          tx,
          event.data.object as Stripe.Subscription,
          now,
        );
      } else if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = getInvoiceSubscriptionId(invoice);
        if (subscriptionId) {
          await tx
            .update(subscriptions)
            .set({ status: "past_due", updatedAt: now })
            .where(eq(subscriptions.stripeSubscriptionId, subscriptionId));
        }
      }

      await tx
        .update(stripeEvents)
        .set({ processedAt: now })
        .where(eq(stripeEvents.id, event.id));
      return true;
    });
    logger.info(
      {
        requestId: req.requestId,
        status: wasProcessed ? "processed" : "duplicate",
        eventType: event.type,
      },
      "Stripe webhook handled",
    );
    res.status(200).json({ received: true, duplicate: !wasProcessed });
  } catch {
    logger.error(
      {
        requestId: req.requestId,
        errorCode: "STRIPE_WEBHOOK_PROCESSING_FAILED",
        eventType: event.type,
      },
      "Stripe webhook processing failed",
    );
    res.status(500).json({
      error: "Webhook processing failed. Stripe may retry this event.",
    });
  }
}

async function syncSubscription(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  subscription: Stripe.Subscription,
  now: Date,
): Promise<void> {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  const metadataUserId = subscription.metadata.userId;
  const [owner] = metadataUserId
    ? await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, metadataUserId))
        .limit(1)
    : await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.stripeCustomerId, customerId))
        .limit(1);
  if (!owner) return;

  const priceId = subscription.items.data[0]?.price.id;
  const metadataPlan = z
    .enum(["free", "starter", "business"])
    .safeParse(subscription.metadata.plan);
  const plan =
    getPlanFromPrice(priceId) ??
    (metadataPlan.success ? metadataPlan.data : "free");
  const status = mapSubscriptionStatus(subscription.status);
  const periodEnd = getSubscriptionPeriodEnd(subscription);
  const currentPeriodEnd =
    periodEnd === null ? null : new Date(periodEnd * 1_000);
  await tx
    .update(users)
    .set({ stripeCustomerId: customerId, updatedAt: now })
    .where(eq(users.id, owner.id));
  await tx
    .insert(subscriptions)
    .values({
      userId: owner.id,
      stripeSubscriptionId: subscription.id,
      plan,
      status,
      currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: subscriptions.stripeSubscriptionId,
      set: {
        plan,
        status,
        currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        updatedAt: now,
      },
    });
}

function getPlanFromPrice(priceId: string | undefined): Plan | null {
  if (priceId && priceId === env.stripePriceStarter) return "starter";
  if (priceId && priceId === env.stripePriceBusiness) return "business";
  return null;
}

function mapSubscriptionStatus(
  status: Stripe.Subscription.Status,
): "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "unpaid":
      return "unpaid";
    default:
      return "incomplete";
  }
}
