import { randomUUID } from "node:crypto";
import Stripe from "stripe";

const secretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const configuredPrices = [
  ["starter", process.env.STRIPE_PRICE_STARTER],
  ["business", process.env.STRIPE_PRICE_BUSINESS],
];

if (!secretKey?.startsWith("sk_test_"))
  throw new Error("Stripe qualification requires a test-mode sk_test_ key.");
if (!webhookSecret?.startsWith("whsec_"))
  throw new Error("Stripe qualification requires a whsec_ signing secret.");
if (configuredPrices.some(([, price]) => !price?.startsWith("price_")))
  throw new Error("Both configured Stripe prices must be price_ identifiers.");
if (configuredPrices[0][1] === configuredPrices[1][1])
  throw new Error(
    "Starter and business plans must use distinct Stripe prices.",
  );

const stripe = new Stripe(secretKey, {
  timeout: 15_000,
  maxNetworkRetries: 1,
});
const qualificationId = randomUUID().replaceAll("-", "");
let customerId;
const sessions = [];
let qualificationError;
let cleanupError;

try {
  for (const [plan, priceId] of configuredPrices) {
    const price = await stripe.prices.retrieve(priceId);
    if (!price.active || !price.recurring)
      throw new Error(
        `Stripe price for ${plan} must be active and recurring in test mode.`,
      );
  }

  const customer = await stripe.customers.create(
    {
      email: `wcm-qualification-${qualificationId}@example.com`,
      name: "Watchtower CI qualification",
      metadata: { qualificationId },
    },
    { idempotencyKey: `wcm-qualification-customer-${qualificationId}` },
  );
  customerId = customer.id;

  for (const [plan, priceId] of configuredPrices) {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        client_reference_id: `qualification-${qualificationId}`,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url:
          "https://example.com/qualification-success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "https://example.com/qualification-cancel",
        metadata: { qualificationId, plan },
        subscription_data: { metadata: { qualificationId, plan } },
      },
      {
        idempotencyKey: `wcm-qualification-checkout-${plan}-${qualificationId}`,
      },
    );
    sessions.push(session);
    if (
      session.mode !== "subscription" ||
      session.status !== "open" ||
      !session.url ||
      session.metadata?.qualificationId !== qualificationId ||
      session.metadata?.plan !== plan ||
      session.customer !== customerId
    ) {
      throw new Error(
        `Stripe did not create the expected ${plan} checkout session.`,
      );
    }
  }

  const syntheticEvent = JSON.stringify({
    id: `evt_qualification_${qualificationId}`,
    object: "event",
    api_version: stripe.getApiField("version"),
    created: Math.floor(Date.now() / 1_000),
    data: { object: { id: sessions[0].id, object: "checkout.session" } },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.completed",
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: syntheticEvent,
    secret: webhookSecret,
  });
  const verifiedEvent = stripe.webhooks.constructEvent(
    syntheticEvent,
    signature,
    webhookSecret,
  );
  if (verifiedEvent.id !== `evt_qualification_${qualificationId}`)
    throw new Error(
      "The configured Stripe webhook signing secret did not verify.",
    );
} catch (error) {
  qualificationError = error;
} finally {
  for (const session of sessions) {
    try {
      const expired = await stripe.checkout.sessions.expire(session.id);
      if (expired.status !== "expired")
        cleanupError ??= new Error(
          `Stripe session ${session.id} was not expired.`,
        );
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (customerId) {
    try {
      const deleted = await stripe.customers.del(customerId);
      if (!deleted.deleted)
        cleanupError ??= new Error(
          `Stripe qualification customer ${customerId} was not deleted.`,
        );
    } catch (error) {
      cleanupError ??= error;
    }
  }
}

if (qualificationError) throw qualificationError;
if (cleanupError) throw cleanupError;
console.log(
  "Stripe test-mode qualification passed: active recurring prices retrieved; starter and business checkout sessions created and expired; webhook signing secret verified against a synthetic test event; temporary customer deleted. No payment was submitted.",
);
