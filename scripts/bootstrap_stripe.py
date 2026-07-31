#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import stripe

from stripe_entitlements.catalog import Plan, PlanCatalog


def _dict(value: Any) -> dict[str, Any]:
    parsed: dict[str, Any] = json.loads(str(value))
    return parsed


def _mode(key: str) -> tuple[bool, str]:
    if key.startswith("sk_test_"):
        return False, "test"
    if key.startswith("sk_live_"):
        return True, "live"
    raise RuntimeError("STRIPE_SECRET_KEY must be an sk_test_ or sk_live_ secret key")


def _products(key: str):
    starting_after: str | None = None
    while True:
        kwargs: dict[str, Any] = {"active": True, "limit": 100, "api_key": key}
        if starting_after:
            kwargs["starting_after"] = starting_after
        page = stripe.Product.list(**kwargs)
        yield from page.data
        if not page.data or not page.has_more:
            return
        starting_after = page.data[-1].id


def _portal_configs(key: str):
    starting_after: str | None = None
    while True:
        kwargs: dict[str, Any] = {"active": True, "limit": 100, "api_key": key}
        if starting_after:
            kwargs["starting_after"] = starting_after
        page = stripe.billing_portal.Configuration.list(**kwargs)
        yield from page.data
        if not page.data or not page.has_more:
            return
        starting_after = page.data[-1].id


def _safe_portal(update: dict[str, Any]) -> bool:
    conditions = {
        item.get("type")
        for item in ((update.get("schedule_at_period_end") or {}).get("conditions") or [])
    }
    return (
        update.get("enabled") is True
        and update.get("proration_behavior") == "always_invoice"
        and update.get("billing_cycle_anchor") == "now"
        and {"decreasing_item_amount", "shortening_interval"} <= conditions
    )


def _find_product(key: str, product_line: str, plan: str):
    for product in _products(key):
        metadata = _dict(product).get("metadata") or {}
        if metadata.get("product_line") == product_line and metadata.get("plan") == plan:
            return product
    return None


def ensure_product(key: str, product_line: str, plan: Plan):
    existing = _find_product(key, product_line, plan.key)
    if existing:
        print(f"product ok: {plan.key} -> {existing.id}")
        return existing
    product = stripe.Product.create(
        name=f"Example Entitlements {plan.key.title()}",
        description=f"Reference catalog plan: {plan.monthly_credits} credits per month",
        metadata={"product_line": product_line, "plan": plan.key},
        api_key=key,
    )
    print(f"product created: {plan.key} -> {product.id}")
    return product


def ensure_price(
    key: str,
    catalog: PlanCatalog,
    product: Any,
    plan: Plan,
    interval: str,
) -> Any:
    lookup_key = catalog.lookup_key(plan.key, interval)
    expected = (plan.month_usd if interval == "month" else plan.year_usd) * 100
    existing = stripe.Price.list(
        lookup_keys=[lookup_key], active=True, limit=1, api_key=key
    ).data
    if existing:
        price = existing[0]
        recurring = _dict(price).get("recurring") or {}
        if (
            price.product == product.id
            and price.currency == "usd"
            and price.unit_amount == expected
            and recurring.get("interval") == interval
        ):
            print(f"price ok: {lookup_key} -> {price.id}")
            return price
    price = stripe.Price.create(
        product=product.id,
        currency="usd",
        unit_amount=expected,
        recurring={"interval": interval},
        lookup_key=lookup_key,
        transfer_lookup_key=True,
        metadata={"product_line": product.metadata["product_line"], "plan": plan.key},
        api_key=key,
    )
    for old in existing:
        stripe.Price.modify(old.id, active=False, api_key=key)
    print(f"price created: {lookup_key} -> {price.id}")
    return price


def ensure_portal(key: str, product_line: str, products: list[dict[str, Any]]) -> Any:
    existing = next(
        (
            config
            for config in _portal_configs(key)
            if (_dict(config).get("metadata") or {}).get("product_line") == product_line
        ),
        None,
    )
    params = {
        "business_profile": {"headline": "Manage your example subscription"},
        "features": {
            "customer_update": {"enabled": True, "allowed_updates": ["email"]},
            "invoice_history": {"enabled": True},
            "payment_method_update": {"enabled": True},
            "subscription_cancel": {"enabled": True, "mode": "at_period_end"},
            "subscription_update": {
                "enabled": True,
                "default_allowed_updates": ["price"],
                "products": products,
                "proration_behavior": "always_invoice",
                "billing_cycle_anchor": "now",
                "schedule_at_period_end": {
                    "conditions": [
                        {"type": "decreasing_item_amount"},
                        {"type": "shortening_interval"},
                    ]
                },
            },
        },
        "metadata": {"product_line": product_line},
    }
    if existing:
        config = stripe.billing_portal.Configuration.modify(
            existing.id, **params, api_key=key
        )
        print(f"portal updated: {config.id}")
        return config
    config = stripe.billing_portal.Configuration.create(**params, api_key=key)
    print(f"portal created: {config.id}")
    return config


def verify(key: str, catalog: PlanCatalog, product_line: str) -> None:
    expected_live, label = _mode(key)
    expected_price_ids: set[str] = set()
    for plan in catalog.plans.values():
        product = _find_product(key, product_line, plan.key)
        if product is None:
            raise RuntimeError(f"missing active product for plan {plan.key}")
        if bool(product.livemode) != expected_live:
            raise RuntimeError("product mode does not match the secret key")
        for interval, amount in (("month", plan.month_usd), ("year", plan.year_usd)):
            lookup_key = catalog.lookup_key(plan.key, interval)
            prices = stripe.Price.list(
                lookup_keys=[lookup_key], active=True, limit=2, api_key=key
            ).data
            if len(prices) != 1:
                raise RuntimeError(f"expected one active price for {lookup_key}")
            price = prices[0]
            recurring = _dict(price).get("recurring") or {}
            if (
                price.product != product.id
                or price.currency != "usd"
                or price.unit_amount != amount * 100
                or recurring.get("interval") != interval
                or bool(price.livemode) != expected_live
            ):
                raise RuntimeError(f"price drift: {lookup_key}")
            expected_price_ids.add(price.id)
    matching = []
    drifted: list[dict[str, Any]] = []
    for raw in _portal_configs(key):
        # List responses can omit the allowed product/price expansion. Retrieve
        # the candidate before validating the complete policy surface.
        config = _dict(
            stripe.billing_portal.Configuration.retrieve(raw.id, api_key=key)
        )
        if (config.get("metadata") or {}).get("product_line") != product_line:
            continue
        update = (config.get("features") or {}).get("subscription_update") or {}
        configured_ids = {
            price if isinstance(price, str) else price.get("id")
            for product in update.get("products") or []
            for price in product["prices"]
        }
        configured_ids.discard(None)
        products_returned = "products" in update
        products_match = not products_returned or configured_ids == expected_price_ids
        if _safe_portal(update) and products_match:
            matching.append(config)
        else:
            drifted.append(
                {
                    "id": config["id"],
                    "enabled": update.get("enabled"),
                    "proration_behavior": update.get("proration_behavior"),
                    "billing_cycle_anchor": update.get("billing_cycle_anchor"),
                    "update_keys": sorted(update),
                    "product_count": len(update.get("products") or []),
                    "conditions": [
                        item.get("type")
                        for item in (
                            (update.get("schedule_at_period_end") or {}).get("conditions")
                            or []
                        )
                    ],
                    "missing_prices": sorted(expected_price_ids - configured_ids),
                    "extra_prices": sorted(configured_ids - expected_price_ids),
                }
            )
    if not matching:
        raise RuntimeError(f"no safe Portal configuration; drifted={drifted}")
    if bool(matching[0].get("livemode")) != expected_live:
        raise RuntimeError("Portal mode does not match the secret key")
    matching_update = (matching[0].get("features") or {}).get("subscription_update") or {}
    product_note = (
        str(len(matching_update.get("products") or []))
        if "products" in matching_update
        else "omitted-by-stripe-api"
    )
    print(
        f"verified {label}: products={len(catalog.plans)} prices={len(expected_price_ids)} "
        f"portal={matching[0]['id']} portal_products={product_note} anchor=now always_invoice"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument(
        "--allow-live",
        action="store_true",
        help="required before creating or modifying live-mode objects",
    )
    parser.add_argument("--catalog", default="plans.toml")
    parser.add_argument("--lookup-prefix", default=os.getenv("LOOKUP_PREFIX", "ent"))
    parser.add_argument(
        "--product-line", default=os.getenv("PRODUCT_LINE", "example-entitlements")
    )
    args = parser.parse_args()
    key = os.environ["STRIPE_SECRET_KEY"]
    live, label = _mode(key)
    catalog = PlanCatalog.from_toml(Path(args.catalog), args.lookup_prefix)
    if args.verify_only:
        verify(key, catalog, args.product_line)
        return
    if live and not args.allow_live:
        raise RuntimeError("live mutation refused; pass --allow-live after release approval")
    print(f"bootstrapping Stripe {label} mode for product_line={args.product_line}")
    portal_products: list[dict[str, Any]] = []
    for plan in catalog.plans.values():
        product = ensure_product(key, args.product_line, plan)
        prices = [
            ensure_price(key, catalog, product, plan, "month"),
            ensure_price(key, catalog, product, plan, "year"),
        ]
        portal_products.append({"product": product.id, "prices": [price.id for price in prices]})
    ensure_portal(key, args.product_line, portal_products)
    verify(key, catalog, args.product_line)


if __name__ == "__main__":
    main()
