import { describe, expect, it } from "vitest";
import {
  getInvoiceSubscriptionId,
  getSubscriptionPeriodEnd,
} from "./billing-utils.js";

describe("invoice subscription reference", () => {
  it("extracts a subscription ID from a string reference", () => {
    expect(
      getInvoiceSubscriptionId({
        parent: { subscription_details: { subscription: "sub_123" } },
      }),
    ).toBe("sub_123");
  });

  it("extracts an ID from an expanded subscription", () => {
    expect(
      getInvoiceSubscriptionId({
        parent: { subscription_details: { subscription: { id: "sub_456" } } },
      }),
    ).toBe("sub_456");
  });

  it("does not infer a subscription for non-subscription invoices", () => {
    expect(getInvoiceSubscriptionId({})).toBeNull();
    expect(getInvoiceSubscriptionId({ parent: null })).toBeNull();
    expect(
      getInvoiceSubscriptionId({
        parent: { subscription_details: null },
      }),
    ).toBeNull();
  });
});

describe("subscription billing period", () => {
  it("uses the earliest current period end across subscription items", () => {
    expect(
      getSubscriptionPeriodEnd({
        items: {
          data: [{ current_period_end: 2_000 }, { current_period_end: 1_800 }],
        },
      }),
    ).toBe(1_800);
  });

  it("returns null when a subscription has no items", () => {
    expect(getSubscriptionPeriodEnd({ items: { data: [] } })).toBeNull();
  });
});
