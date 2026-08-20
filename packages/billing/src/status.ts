export type BillingStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "inactive";

export function normalizeBillingStatus(stripeStatus: string): BillingStatus {
  switch (stripeStatus) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "incomplete":
    case "incomplete_expired":
      return "incomplete";
    default:
      return "inactive";
  }
}

export type SubscriptionState = {
  status: BillingStatus;
  trialEndsAt?: Date;
  currentPeriodEnd?: Date;
};

export function isInActiveTrial(sub: SubscriptionState): boolean {
  if (sub.status !== "trialing") return false;
  if (sub.trialEndsAt === undefined) return false;
  return sub.trialEndsAt > new Date();
}

export function hasPaidPlanAccess(sub: SubscriptionState): boolean {
  return sub.status === "active" || sub.status === "trialing";
}

export function isSubscriptionExpired(sub: SubscriptionState): boolean {
  return sub.status === "canceled" || sub.status === "inactive";
}

export function subscriptionNeedsAttention(sub: SubscriptionState): boolean {
  return sub.status === "past_due" || sub.status === "incomplete";
}
