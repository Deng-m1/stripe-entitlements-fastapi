#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import stripe

from stripe_entitlements.catalog import CreditPack, Plan, PlanCatalog
from stripe_entitlements.portal_policy import portal_configuration_is_safe
from stripe_entitlements.price_policy import catalog_one_time_price_matches
from stripe_entitlements.stripe_gateway import StripeGateway

STRIPE_API_VERSION = os.getenv("STRIPE_API_VERSION", "2026-06-24.dahlia")


def _options(key: str) -> dict[str, str]:
    return {"api_key": key, "stripe_version": STRIPE_API_VERSION}


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
        kwargs: dict[str, Any] = {"active": True, "limit": 100, **_options(key)}
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
        kwargs: dict[str, Any] = {"active": True, "limit": 100, **_options(key)}
        if starting_after:
            kwargs["starting_after"] = starting_after
        page = stripe.billing_portal.Configuration.list(**kwargs)
        yield from page.data
        if not page.data or not page.has_more:
            return
        starting_after = page.data[-1].id


def _safe_portal(
    config: dict[str, Any],
    expected_livemode: bool = False,
    expected_product_line: str = "example-entitlements",
) -> bool:
    return portal_configuration_is_safe(
        config,
        expected_livemode=expected_livemode,
        expected_product_line=expected_product_line,
    )


def _find_product(key: str, product_line: str, plan: str):
    for product in _products(key):
        metadata = _dict(product).get("metadata") or {}
        if metadata.get("product_line") == product_line and metadata.get("plan") == plan:
            return product
    return None


def _find_pack_product(key: str, product_line: str, pack_key: str):
    for product in _products(key):
        metadata = _dict(product).get("metadata") or {}
        if (
            metadata.get("product_line") == product_line
            and metadata.get("credit_pack") == pack_key
            and metadata.get("plan") is None
        ):
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
        **_options(key),
    )
    print(f"product created: {plan.key} -> {product.id}")
    return product


def ensure_pack_product(key: str, product_line: str, pack: CreditPack):
    existing = _find_pack_product(key, product_line, pack.key)
    if existing:
        print(f"credit-pack product ok: {pack.key} -> {existing.id}")
        return existing
    product = stripe.Product.create(
        name=f"Example Entitlements {pack.name}",
        description=f"One-time reference credit pack: {pack.credits} credits",
        metadata={"product_line": product_line, "credit_pack": pack.key},
        **_options(key),
    )
    print(f"credit-pack product created: {pack.key} -> {product.id}")
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
        lookup_keys=[lookup_key],
        active=True,
        limit=1,
        expand=["data.currency_options", "data.product"],
        **_options(key),
    ).data
    if existing:
        price = existing[0]
        price_raw = _dict(price)
        if StripeGateway._object_id(
            price_raw.get("product")
        ) == product.id and StripeGateway._catalog_price_matches(
            price_raw,
            expected_currency=plan.currency,
            expected_unit_amount=expected,
            expected_interval=interval,
            expected_product_line=str(product.metadata["product_line"]),
            expected_plan_key=plan.key,
            expected_lookup_key=lookup_key,
        ):
            print(f"price ok: {lookup_key} -> {price.id}")
            return price
    price = stripe.Price.create(
        product=product.id,
        currency=plan.currency,
        unit_amount=expected,
        recurring={
            "interval": interval,
            "interval_count": 1,
            "usage_type": "licensed",
        },
        lookup_key=lookup_key,
        transfer_lookup_key=True,
        metadata={"product_line": product.metadata["product_line"], "plan": plan.key},
        **_options(key),
    )
    for old in existing:
        stripe.Price.modify(old.id, active=False, **_options(key))
    print(f"price created: {lookup_key} -> {price.id}")
    return price


def ensure_pack_price(
    key: str,
    catalog: PlanCatalog,
    product: Any,
    pack: CreditPack,
) -> Any:
    lookup_key = catalog.credit_pack_lookup_key(pack.key)
    expected = pack.price_usd * 100
    existing = stripe.Price.list(
        lookup_keys=[lookup_key],
        active=True,
        limit=2,
        expand=["data.currency_options", "data.product"],
        **_options(key),
    ).data
    if len(existing) == 1:
        price = existing[0]
        price_raw = _dict(price)
        if StripeGateway._object_id(price_raw.get("product")) == product.id and (
            catalog_one_time_price_matches(
                price_raw,
                expected_currency=pack.currency,
                expected_unit_amount=expected,
                expected_product_line=str(product.metadata["product_line"]),
                expected_pack_key=pack.key,
                expected_lookup_key=lookup_key,
            )
        ):
            print(f"credit-pack price ok: {lookup_key} -> {price.id}")
            return price
    price = stripe.Price.create(
        product=product.id,
        currency=pack.currency,
        unit_amount=expected,
        lookup_key=lookup_key,
        transfer_lookup_key=True,
        metadata={
            "product_line": product.metadata["product_line"],
            "credit_pack": pack.key,
        },
        **_options(key),
    )
    for old in existing:
        stripe.Price.modify(old.id, active=False, **_options(key))
    print(f"credit-pack price created: {lookup_key} -> {price.id}")
    return price


def ensure_portal(key: str, product_line: str) -> Any:
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
            # Price changes are server-only so rank, annual funding lineage,
            # preview, idempotency, and entitlement attribution cannot be bypassed.
            "subscription_update": {"enabled": False},
        },
        "metadata": {"product_line": product_line},
    }
    if existing:
        config = stripe.billing_portal.Configuration.modify(existing.id, **params, **_options(key))
        print(f"portal updated: {config.id}")
        return config
    config = stripe.billing_portal.Configuration.create(**params, **_options(key))
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
                lookup_keys=[lookup_key],
                active=True,
                limit=2,
                expand=["data.currency_options", "data.product"],
                **_options(key),
            ).data
            if len(prices) != 1:
                raise RuntimeError(f"expected one active price for {lookup_key}")
            price = prices[0]
            price_raw = _dict(price)
            if (
                StripeGateway._object_id(price_raw.get("product")) != product.id
                or not StripeGateway._catalog_price_matches(
                    price_raw,
                    expected_currency=plan.currency,
                    expected_unit_amount=amount * 100,
                    expected_interval=interval,
                    expected_product_line=product_line,
                    expected_plan_key=plan.key,
                    expected_lookup_key=lookup_key,
                )
                or bool(price.livemode) != expected_live
            ):
                raise RuntimeError(f"price drift: {lookup_key}")
            expected_price_ids.add(price.id)
    expected_pack_price_ids: set[str] = set()
    for pack in catalog.ordered_credit_packs():
        product = _find_pack_product(key, product_line, pack.key)
        if product is None:
            raise RuntimeError(f"missing active product for credit pack {pack.key}")
        if bool(product.livemode) != expected_live:
            raise RuntimeError("credit-pack product mode does not match the secret key")
        lookup_key = catalog.credit_pack_lookup_key(pack.key)
        prices = stripe.Price.list(
            lookup_keys=[lookup_key],
            active=True,
            limit=2,
            expand=["data.currency_options", "data.product"],
            **_options(key),
        ).data
        if len(prices) != 1:
            raise RuntimeError(f"expected one active price for {lookup_key}")
        price = prices[0]
        price_raw = _dict(price)
        if (
            StripeGateway._object_id(price_raw.get("product")) != product.id
            or not catalog_one_time_price_matches(
                price_raw,
                expected_currency=pack.currency,
                expected_unit_amount=pack.price_usd * 100,
                expected_product_line=product_line,
                expected_pack_key=pack.key,
                expected_lookup_key=lookup_key,
            )
            or bool(price.livemode) != expected_live
        ):
            raise RuntimeError(f"credit-pack price drift: {lookup_key}")
        expected_pack_price_ids.add(price.id)
    matching = []
    drifted: list[dict[str, Any]] = []
    for raw in _portal_configs(key):
        # List responses can omit the allowed product/price expansion. Retrieve
        # the candidate before validating the complete policy surface.
        config = _dict(stripe.billing_portal.Configuration.retrieve(raw.id, **_options(key)))
        if (config.get("metadata") or {}).get("product_line") != product_line:
            continue
        update = (config.get("features") or {}).get("subscription_update") or {}
        if _safe_portal(config, expected_live, product_line):
            matching.append(config)
        else:
            drifted.append(
                {
                    "id": config["id"],
                    "enabled": update.get("enabled"),
                    "update_keys": sorted(update),
                }
            )
    if not matching:
        raise RuntimeError(f"no safe Portal configuration; drifted={drifted}")
    if bool(matching[0].get("livemode")) != expected_live:
        raise RuntimeError("Portal mode does not match the secret key")
    print(
        f"verified {label}: products={len(catalog.plans)} prices={len(expected_price_ids)} "
        f"credit_pack_products={len(catalog.credit_packs)} "
        f"credit_pack_prices={len(expected_pack_price_ids)} "
        f"portal={matching[0]['id']} subscription_update=disabled "
        f"stripe_api_version={STRIPE_API_VERSION}"
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
    parser.add_argument("--product-line", default=os.getenv("PRODUCT_LINE", "example-entitlements"))
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
    for plan in catalog.plans.values():
        product = ensure_product(key, args.product_line, plan)
        ensure_price(key, catalog, product, plan, "month")
        ensure_price(key, catalog, product, plan, "year")
    for pack in catalog.ordered_credit_packs():
        product = ensure_pack_product(key, args.product_line, pack)
        ensure_pack_price(key, catalog, product, pack)
    ensure_portal(key, args.product_line)
    verify(key, catalog, args.product_line)


if __name__ == "__main__":
    main()
