# ventora-billing

Stripe billing helpers: plan registry, checkout/portal session creation, subscription status normalization, trial lifecycle, and webhook verification.

## Install

```bash
uv add ventora-billing
```

## Usage

```python
from ventora_billing import (
    BillingPlan,
    create_plan_registry,
    has_paid_plan_access,
    normalize_billing_status,
    SubscriptionState,
)

registry = create_plan_registry([
    BillingPlan(
        id="pro",
        name="Pro",
        features=["exports", "api_access"],
        prices={"month": "price_pro_monthly", "year": "price_pro_annual"},
        trial_days=14,
        is_default=True,
    ),
])

price_id = registry.get_price_id("pro", cadence="year")
plan = registry.resolve_plan_from_price_id(price_id)

status = normalize_billing_status("active")  # -> "active"
state = SubscriptionState(status=status)
if has_paid_plan_access(state):
    ...
```

## Notes
- `PlanRegistry` rejects duplicate plan IDs and duplicate price IDs across plans at construction time, so a misconfigured plan list fails fast instead of silently shadowing a price.
- `normalize_billing_status` maps Stripe's raw status strings (including `cancelled` and `incomplete_expired`) onto the fixed `BillingStatus` literal, defaulting unknown values to `"inactive"`.
