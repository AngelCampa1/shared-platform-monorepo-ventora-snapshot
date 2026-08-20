export type BillingCadence = "month" | "year";

export type BillingPlan = {
  id: string;
  name: string;
  description?: string;
  features: string[];
  limits?: Record<string, number | string | null>;
  prices: Partial<Record<BillingCadence, string>>; // Stripe price IDs
  trialDays?: number;
  isDefault?: boolean;
};

export interface PlanRegistry {
  readonly plans: readonly BillingPlan[];
  resolvePlanFromPriceId(priceId: string | null | undefined): BillingPlan | null;
  getPriceId(planId: string, cadence?: BillingCadence): string; // throws if not found
  hasFeatureAccess(planId: string, feature: string): boolean;
  getDefaultPlan(): BillingPlan | null;
  getTrialDays(planId: string): number; // returns plan.trialDays ?? 30 as default
}

export function createPlanRegistry(plans: BillingPlan[]): PlanRegistry {
  if (plans.length === 0) {
    throw new Error("PlanRegistry requires at least one plan");
  }

  const idSet = new Set<string>();
  for (const plan of plans) {
    if (idSet.has(plan.id)) {
      throw new Error(`Duplicate plan ID: ${plan.id}`);
    }
    idSet.add(plan.id);
  }

  const priceIdMap = new Map<string, BillingPlan>();
  for (const plan of plans) {
    for (const priceId of Object.values(plan.prices)) {
      if (priceId !== undefined) {
        if (priceIdMap.has(priceId)) {
          throw new Error(`Duplicate price ID: ${priceId}`);
        }
        priceIdMap.set(priceId, plan);
      }
    }
  }

  const planMap = new Map<string, BillingPlan>(plans.map((p) => [p.id, p]));

  return {
    get plans(): readonly BillingPlan[] {
      return plans;
    },

    resolvePlanFromPriceId(priceId: string | null | undefined): BillingPlan | null {
      if (priceId == null) return null;
      return priceIdMap.get(priceId) ?? null;
    },

    getPriceId(planId: string, cadence: BillingCadence = "month"): string {
      const plan = planMap.get(planId);
      if (plan === undefined) {
        throw new Error(`Plan not found: ${planId}`);
      }
      const priceId = plan.prices[cadence];
      if (priceId === undefined) {
        throw new Error(`No price found for plan "${planId}" with cadence "${cadence}"`);
      }
      return priceId;
    },

    hasFeatureAccess(planId: string, feature: string): boolean {
      const plan = planMap.get(planId);
      if (plan === undefined) return false;
      return plan.features.includes(feature);
    },

    getDefaultPlan(): BillingPlan | null {
      return plans.find((p) => p.isDefault === true) ?? null;
    },

    getTrialDays(planId: string): number {
      const plan = planMap.get(planId);
      if (plan === undefined) return 30;
      return plan.trialDays ?? 30;
    },
  };
}
