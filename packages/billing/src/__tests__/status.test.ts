import { describe, expect, it } from "vitest";
import {
  hasPaidPlanAccess,
  isInActiveTrial,
  isSubscriptionExpired,
  normalizeBillingStatus,
  subscriptionNeedsAttention,
} from "../status.js";
import type { SubscriptionState } from "../status.js";

describe("normalizeBillingStatus", () => {
  it("maps trialing → trialing", () => {
    expect(normalizeBillingStatus("trialing")).toBe("trialing");
  });

  it("maps active → active", () => {
    expect(normalizeBillingStatus("active")).toBe("active");
  });

  it("maps past_due → past_due", () => {
    expect(normalizeBillingStatus("past_due")).toBe("past_due");
  });

  it("maps canceled → canceled", () => {
    expect(normalizeBillingStatus("canceled")).toBe("canceled");
  });

  it("maps cancelled (UK spelling) → canceled", () => {
    expect(normalizeBillingStatus("cancelled")).toBe("canceled");
  });

  it("maps incomplete → incomplete", () => {
    expect(normalizeBillingStatus("incomplete")).toBe("incomplete");
  });

  it("maps incomplete_expired → incomplete", () => {
    expect(normalizeBillingStatus("incomplete_expired")).toBe("incomplete");
  });

  it("maps unknown string → inactive", () => {
    expect(normalizeBillingStatus("paused")).toBe("inactive");
    expect(normalizeBillingStatus("unknown_status")).toBe("inactive");
    expect(normalizeBillingStatus("")).toBe("inactive");
  });
});

describe("isInActiveTrial", () => {
  it("returns true when status is trialing and trialEndsAt is in the future", () => {
    const future = new Date(Date.now() + 86_400_000); // +1 day
    const sub: SubscriptionState = { status: "trialing", trialEndsAt: future };
    expect(isInActiveTrial(sub)).toBe(true);
  });

  it("returns false when status is trialing but trialEndsAt is in the past", () => {
    const past = new Date(Date.now() - 86_400_000); // -1 day
    const sub: SubscriptionState = { status: "trialing", trialEndsAt: past };
    expect(isInActiveTrial(sub)).toBe(false);
  });

  it("returns false when status is trialing but trialEndsAt is undefined", () => {
    const sub: SubscriptionState = { status: "trialing" };
    expect(isInActiveTrial(sub)).toBe(false);
  });

  it("returns false when status is active even if trialEndsAt is future", () => {
    const future = new Date(Date.now() + 86_400_000);
    const sub: SubscriptionState = { status: "active", trialEndsAt: future };
    expect(isInActiveTrial(sub)).toBe(false);
  });

  it("returns false when status is canceled", () => {
    const future = new Date(Date.now() + 86_400_000);
    const sub: SubscriptionState = { status: "canceled", trialEndsAt: future };
    expect(isInActiveTrial(sub)).toBe(false);
  });
});

describe("hasPaidPlanAccess", () => {
  it("returns true for active status", () => {
    expect(hasPaidPlanAccess({ status: "active" })).toBe(true);
  });

  it("returns true for trialing status", () => {
    expect(hasPaidPlanAccess({ status: "trialing" })).toBe(true);
  });

  it("returns false for past_due status", () => {
    expect(hasPaidPlanAccess({ status: "past_due" })).toBe(false);
  });

  it("returns false for canceled status", () => {
    expect(hasPaidPlanAccess({ status: "canceled" })).toBe(false);
  });

  it("returns false for incomplete status", () => {
    expect(hasPaidPlanAccess({ status: "incomplete" })).toBe(false);
  });

  it("returns false for inactive status", () => {
    expect(hasPaidPlanAccess({ status: "inactive" })).toBe(false);
  });
});

describe("isSubscriptionExpired", () => {
  it("returns true for canceled status", () => {
    expect(isSubscriptionExpired({ status: "canceled" })).toBe(true);
  });

  it("returns true for inactive status", () => {
    expect(isSubscriptionExpired({ status: "inactive" })).toBe(true);
  });

  it("returns false for active status", () => {
    expect(isSubscriptionExpired({ status: "active" })).toBe(false);
  });

  it("returns false for trialing status", () => {
    expect(isSubscriptionExpired({ status: "trialing" })).toBe(false);
  });

  it("returns false for past_due status", () => {
    expect(isSubscriptionExpired({ status: "past_due" })).toBe(false);
  });

  it("returns false for incomplete status", () => {
    expect(isSubscriptionExpired({ status: "incomplete" })).toBe(false);
  });
});

describe("subscriptionNeedsAttention", () => {
  it("returns true for past_due status", () => {
    expect(subscriptionNeedsAttention({ status: "past_due" })).toBe(true);
  });

  it("returns true for incomplete status", () => {
    expect(subscriptionNeedsAttention({ status: "incomplete" })).toBe(true);
  });

  it("returns false for active status", () => {
    expect(subscriptionNeedsAttention({ status: "active" })).toBe(false);
  });

  it("returns false for trialing status", () => {
    expect(subscriptionNeedsAttention({ status: "trialing" })).toBe(false);
  });

  it("returns false for canceled status", () => {
    expect(subscriptionNeedsAttention({ status: "canceled" })).toBe(false);
  });

  it("returns false for inactive status", () => {
    expect(subscriptionNeedsAttention({ status: "inactive" })).toBe(false);
  });
});
