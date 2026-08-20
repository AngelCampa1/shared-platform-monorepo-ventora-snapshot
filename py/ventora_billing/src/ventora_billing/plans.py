from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class BillingPlan:
    id: str
    name: str
    features: list[str]
    prices: dict[str, str]  # {"month": "price_xxx", "year": "price_yyy"}
    description: str | None = None
    limits: dict[str, Any] | None = None
    trial_days: int | None = None
    is_default: bool = False


class PlanRegistry:
    def __init__(self, plans: list[BillingPlan]) -> None:
        if not plans:
            raise ValueError("PlanRegistry requires at least one plan")
        ids = [p.id for p in plans]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate plan IDs")
        all_prices = [pid for p in plans for pid in p.prices.values()]
        if len(all_prices) != len(set(all_prices)):
            raise ValueError("Duplicate price IDs across plans")
        self._plans = plans
        self._by_price: dict[str, BillingPlan] = {
            pid: plan for plan in plans for pid in plan.prices.values()
        }
        self._by_id: dict[str, BillingPlan] = {p.id: p for p in plans}

    @property
    def plans(self) -> list[BillingPlan]:
        return list(self._plans)

    def resolve_plan_from_price_id(self, price_id: str | None) -> BillingPlan | None:
        if not price_id:
            return None
        return self._by_price.get(price_id)

    def get_price_id(self, plan_id: str, cadence: str = "month") -> str:
        plan = self._by_id.get(plan_id)
        if not plan:
            raise KeyError(f"Plan not found: {plan_id!r}")
        price = plan.prices.get(cadence)
        if not price:
            raise KeyError(f"No price for plan {plan_id!r} with cadence {cadence!r}")
        return price

    def has_feature_access(self, plan_id: str, feature: str) -> bool:
        plan = self._by_id.get(plan_id)
        if not plan:
            return False
        return feature in plan.features

    def get_default_plan(self) -> BillingPlan | None:
        return next((p for p in self._plans if p.is_default), None)

    def get_trial_days(self, plan_id: str) -> int:
        plan = self._by_id.get(plan_id)
        if not plan or plan.trial_days is None:
            return 30
        return plan.trial_days


def create_plan_registry(plans: list[BillingPlan]) -> PlanRegistry:
    return PlanRegistry(plans)
