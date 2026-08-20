from __future__ import annotations
import pytest
from ventora_billing.plans import BillingPlan, PlanRegistry, create_plan_registry


def make_plan(
    plan_id: str = "starter",
    name: str = "Starter",
    features: list[str] | None = None,
    prices: dict[str, str] | None = None,
    trial_days: int | None = None,
    is_default: bool = False,
) -> BillingPlan:
    return BillingPlan(
        id=plan_id,
        name=name,
        features=features or ["feature_a"],
        prices=prices or {"month": f"price_{plan_id}_m", "year": f"price_{plan_id}_y"},
        trial_days=trial_days,
        is_default=is_default,
    )


# --- Construction errors ---

def test_empty_list_raises():
    with pytest.raises(ValueError, match="at least one plan"):
        create_plan_registry([])


def test_duplicate_plan_ids_raise():
    p1 = make_plan("pro", prices={"month": "price_pro_m"})
    p2 = make_plan("pro", prices={"month": "price_pro2_m"})
    with pytest.raises(ValueError, match="Duplicate plan IDs"):
        create_plan_registry([p1, p2])


def test_duplicate_price_ids_raise():
    p1 = make_plan("starter", prices={"month": "price_shared"})
    p2 = make_plan("pro", prices={"month": "price_shared"})
    with pytest.raises(ValueError, match="Duplicate price IDs"):
        create_plan_registry([p1, p2])


# --- resolve_plan_from_price_id ---

def test_resolve_by_monthly_price():
    plan = make_plan("starter", prices={"month": "price_m", "year": "price_y"})
    registry = create_plan_registry([plan])
    assert registry.resolve_plan_from_price_id("price_m") is plan


def test_resolve_by_yearly_price():
    plan = make_plan("starter", prices={"month": "price_m", "year": "price_y"})
    registry = create_plan_registry([plan])
    assert registry.resolve_plan_from_price_id("price_y") is plan


def test_resolve_unknown_price_returns_none():
    plan = make_plan("starter", prices={"month": "price_m"})
    registry = create_plan_registry([plan])
    assert registry.resolve_plan_from_price_id("price_unknown") is None


def test_resolve_none_returns_none():
    plan = make_plan("starter", prices={"month": "price_m"})
    registry = create_plan_registry([plan])
    assert registry.resolve_plan_from_price_id(None) is None


# --- get_price_id ---

def test_get_price_id_monthly():
    plan = make_plan("starter", prices={"month": "price_m", "year": "price_y"})
    registry = create_plan_registry([plan])
    assert registry.get_price_id("starter", "month") == "price_m"


def test_get_price_id_yearly():
    plan = make_plan("starter", prices={"month": "price_m", "year": "price_y"})
    registry = create_plan_registry([plan])
    assert registry.get_price_id("starter", "year") == "price_y"


def test_get_price_id_unknown_plan_raises():
    plan = make_plan("starter", prices={"month": "price_m"})
    registry = create_plan_registry([plan])
    with pytest.raises(KeyError, match="Plan not found"):
        registry.get_price_id("nonexistent")


def test_get_price_id_unknown_cadence_raises():
    plan = make_plan("starter", prices={"month": "price_m"})
    registry = create_plan_registry([plan])
    with pytest.raises(KeyError, match="No price for plan"):
        registry.get_price_id("starter", "quarter")


# --- has_feature_access ---

def test_has_feature_access_true():
    plan = make_plan("starter", features=["analytics", "export"])
    registry = create_plan_registry([plan])
    assert registry.has_feature_access("starter", "analytics") is True


def test_has_feature_access_false_missing_feature():
    plan = make_plan("starter", features=["analytics"])
    registry = create_plan_registry([plan])
    assert registry.has_feature_access("starter", "export") is False


def test_has_feature_access_false_unknown_plan():
    plan = make_plan("starter", features=["analytics"])
    registry = create_plan_registry([plan])
    assert registry.has_feature_access("ghost", "analytics") is False


# --- get_default_plan ---

def test_get_default_plan_returns_marked_plan():
    p1 = make_plan("free", prices={"month": "price_free_m"}, is_default=True)
    p2 = make_plan("pro", prices={"month": "price_pro_m"})
    registry = create_plan_registry([p1, p2])
    default = registry.get_default_plan()
    assert default is not None
    assert default.id == "free"


def test_get_default_plan_returns_none_when_none_marked():
    p1 = make_plan("free", prices={"month": "price_free_m"})
    p2 = make_plan("pro", prices={"month": "price_pro_m"})
    registry = create_plan_registry([p1, p2])
    assert registry.get_default_plan() is None


# --- get_trial_days ---

def test_get_trial_days_returns_plan_value():
    plan = make_plan("pro", prices={"month": "price_pro_m"}, trial_days=14)
    registry = create_plan_registry([plan])
    assert registry.get_trial_days("pro") == 14


def test_get_trial_days_returns_default_30_when_none():
    plan = make_plan("pro", prices={"month": "price_pro_m"}, trial_days=None)
    registry = create_plan_registry([plan])
    assert registry.get_trial_days("pro") == 30


def test_get_trial_days_returns_default_30_for_unknown_plan():
    plan = make_plan("pro", prices={"month": "price_pro_m"}, trial_days=7)
    registry = create_plan_registry([plan])
    assert registry.get_trial_days("nonexistent") == 30


# --- plans property ---

def test_plans_property_returns_copy():
    plan = make_plan("starter", prices={"month": "price_m"})
    registry = create_plan_registry([plan])
    plans = registry.plans
    assert len(plans) == 1
    plans.append(make_plan("extra", prices={"month": "price_extra_m"}))
    assert len(registry.plans) == 1  # original unmodified
