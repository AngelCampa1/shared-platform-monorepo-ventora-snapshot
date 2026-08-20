import { describe, expect, it } from "vitest";
import { type BillingPlan, createPlanRegistry } from "../plans.js";

const makePlan = (overrides: Partial<BillingPlan> = {}): BillingPlan => ({
  id: "starter",
  name: "Starter",
  features: ["feature-a", "feature-b"],
  prices: { month: "price_monthly_123", year: "price_yearly_123" },
  ...overrides,
});

const proplan: BillingPlan = {
  id: "pro",
  name: "Pro",
  features: ["feature-a", "feature-b", "feature-pro"],
  prices: { month: "price_pro_monthly", year: "price_pro_yearly" },
  trialDays: 14,
  isDefault: true,
};

describe("createPlanRegistry – validation", () => {
  it("throws when passed an empty array", () => {
    expect(() => createPlanRegistry([])).toThrow("at least one plan");
  });

  it("throws on duplicate plan IDs", () => {
    expect(() =>
      createPlanRegistry([makePlan(), makePlan({ prices: { month: "price_other" } })]),
    ).toThrow("Duplicate plan ID");
  });

  it("throws on duplicate price IDs across plans", () => {
    const p1 = makePlan();
    const p2 = makePlan({ id: "pro", prices: { month: "price_monthly_123" } });
    expect(() => createPlanRegistry([p1, p2])).toThrow("Duplicate price ID");
  });

  it("succeeds with valid plans", () => {
    const registry = createPlanRegistry([makePlan(), proplan]);
    expect(registry.plans).toHaveLength(2);
  });
});

describe("resolvePlanFromPriceId", () => {
  const registry = createPlanRegistry([makePlan(), proplan]);

  it("finds plan by monthly price ID", () => {
    const plan = registry.resolvePlanFromPriceId("price_monthly_123");
    expect(plan?.id).toBe("starter");
  });

  it("finds plan by yearly price ID", () => {
    const plan = registry.resolvePlanFromPriceId("price_yearly_123");
    expect(plan?.id).toBe("starter");
  });

  it("finds plan by pro monthly price ID", () => {
    const plan = registry.resolvePlanFromPriceId("price_pro_yearly");
    expect(plan?.id).toBe("pro");
  });

  it("returns null for unknown price ID", () => {
    expect(registry.resolvePlanFromPriceId("price_unknown")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(registry.resolvePlanFromPriceId(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(registry.resolvePlanFromPriceId(undefined)).toBeNull();
  });
});

describe("getPriceId", () => {
  const registry = createPlanRegistry([makePlan(), proplan]);

  it("returns monthly price ID", () => {
    expect(registry.getPriceId("starter", "month")).toBe("price_monthly_123");
  });

  it("returns yearly price ID", () => {
    expect(registry.getPriceId("starter", "year")).toBe("price_yearly_123");
  });

  it("defaults cadence to month", () => {
    expect(registry.getPriceId("starter")).toBe("price_monthly_123");
  });

  it("throws if plan not found", () => {
    expect(() => registry.getPriceId("nonexistent", "month")).toThrow("Plan not found");
  });

  it("throws if cadence not available on plan", () => {
    const registry2 = createPlanRegistry([makePlan({ prices: { month: "price_mo" } })]);
    expect(() => registry2.getPriceId("starter", "year")).toThrow("No price found");
  });
});

describe("hasFeatureAccess", () => {
  const registry = createPlanRegistry([makePlan(), proplan]);

  it("returns true when plan has the feature", () => {
    expect(registry.hasFeatureAccess("starter", "feature-a")).toBe(true);
  });

  it("returns false when plan does not have the feature", () => {
    expect(registry.hasFeatureAccess("starter", "feature-pro")).toBe(false);
  });

  it("returns false for unknown planId", () => {
    expect(registry.hasFeatureAccess("ghost", "feature-a")).toBe(false);
  });
});

describe("getDefaultPlan", () => {
  it("returns plan with isDefault: true", () => {
    const registry = createPlanRegistry([makePlan(), proplan]);
    expect(registry.getDefaultPlan()?.id).toBe("pro");
  });

  it("returns null when no plan has isDefault: true", () => {
    const registry = createPlanRegistry([makePlan()]);
    expect(registry.getDefaultPlan()).toBeNull();
  });
});

describe("getTrialDays", () => {
  const registry = createPlanRegistry([makePlan(), proplan]);

  it("returns plan's trialDays when set", () => {
    expect(registry.getTrialDays("pro")).toBe(14);
  });

  it("returns 30 as default when trialDays is not set", () => {
    expect(registry.getTrialDays("starter")).toBe(30);
  });

  it("returns 30 for unknown planId", () => {
    expect(registry.getTrialDays("nonexistent")).toBe(30);
  });
});
