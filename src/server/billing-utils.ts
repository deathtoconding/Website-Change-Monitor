type InvoiceSubscriptionSource = {
  parent?: {
    subscription_details?: {
      subscription?: string | { id: string } | null;
    } | null;
  } | null;
};

type SubscriptionPeriodSource = {
  items: { data: readonly { current_period_end: number }[] };
};

export function getInvoiceSubscriptionId(
  invoice: InvoiceSubscriptionSource,
): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (typeof subscription === "string") return subscription;
  return subscription?.id ?? null;
}

/** Stripe now exposes billing period end timestamps on subscription items. */
export function getSubscriptionPeriodEnd(
  subscription: SubscriptionPeriodSource,
): number | null {
  const periodEnds = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((periodEnd) => Number.isFinite(periodEnd));
  return periodEnds.length ? Math.min(...periodEnds) : null;
}
