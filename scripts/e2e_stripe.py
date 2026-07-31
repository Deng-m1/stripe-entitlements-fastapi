#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

import asyncpg
import stripe

SUPPORTED_EVENTS = (
    "checkout.session.completed",
    "checkout.session.expired",
    "invoice.paid",
    "invoice.payment_failed",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "charge.refunded",
    "charge.dispute.created",
)
E2E_PRODUCT_LINE = "example-entitlements"


def _test_key() -> str:
    key = os.environ.get("STRIPE_SECRET_KEY", "")
    if not key.startswith("sk_test_"):
        raise RuntimeError("browser E2E refuses keys that do not start with sk_test_")
    return key


def _options() -> dict[str, Any]:
    return {
        "api_key": _test_key(),
        "stripe_version": os.environ.get(
            "STRIPE_API_VERSION", "2026-06-24.dahlia"
        ),
    }


def _dict(value: Any) -> dict[str, Any]:
    parsed: dict[str, Any] = json.loads(str(value))
    return parsed


def _object_id(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and value.get("id"):
        return str(value["id"])
    return None


def create_webhook(args: argparse.Namespace) -> None:
    endpoint = stripe.WebhookEndpoint.create(
        url=args.url,
        enabled_events=list(SUPPORTED_EVENTS),
        api_version=args.event_api_version,
        description=args.description,
        **_options(),
    )
    raw = _dict(endpoint)
    secret = raw.get("secret")
    if not secret or not str(secret).startswith("whsec_"):
        raise RuntimeError("Stripe did not return a webhook signing secret")
    output = Path(args.output)
    output.write_text(
        json.dumps(
            {
                "endpoint_id": str(raw["id"]),
                "webhook_secret": str(secret),
                "url": args.url,
                "event_api_version": args.event_api_version,
                "description": args.description,
            }
        ),
        encoding="utf-8",
    )
    output.chmod(0o600)


def verify_webhook(args: argparse.Namespace) -> None:
    raw = _dict(stripe.WebhookEndpoint.retrieve(args.endpoint_id, **_options()))
    actual_events = set(raw.get("enabled_events") or [])
    expected_events = set(SUPPORTED_EVENTS)
    if bool(raw.get("livemode")):
        raise RuntimeError("E2E endpoint unexpectedly belongs to live mode")
    if raw.get("status") != "enabled":
        raise RuntimeError("E2E endpoint is not enabled")
    if raw.get("url") != args.url:
        raise RuntimeError("E2E endpoint URL drifted")
    if raw.get("api_version") != args.event_api_version:
        raise RuntimeError("E2E endpoint Event API version drifted")
    if actual_events != expected_events:
        raise RuntimeError("E2E endpoint enabled event contract drifted")
    print(
        "verified test webhook endpoint: "
        f"api_version={raw['api_version']} events={len(actual_events)}"
    )


def delete_webhook(args: argparse.Namespace) -> None:
    try:
        endpoint = stripe.WebhookEndpoint.retrieve(args.endpoint_id, **_options())
        raw = _dict(endpoint)
    except stripe.InvalidRequestError:
        return
    if bool(raw.get("livemode")):
        raise RuntimeError("refusing to delete a live webhook endpoint")
    if raw.get("description") != args.description:
        raise RuntimeError("refusing to delete an endpoint outside this E2E run")
    endpoint.delete(**_options())


def delete_webhook_by_description(args: argparse.Namespace) -> None:
    endpoints = stripe.WebhookEndpoint.list(limit=100, **_options())
    matches = []
    for endpoint in endpoints.data:
        raw = _dict(endpoint)
        if (
            not bool(raw.get("livemode"))
            and raw.get("description") == args.description
            and raw.get("url") == args.url
        ):
            matches.append(endpoint)
    if len(matches) > 1:
        raise RuntimeError("multiple Webhook Endpoints matched one E2E run identity")
    if matches:
        matches[0].delete(**_options())


async def write_cleanup_manifest(args: argparse.Namespace) -> None:
    manifest: dict[str, Any] = {
        "endpoint_id": args.endpoint_id or None,
        "endpoint_description": args.description,
        "endpoint_url": args.url,
        "external_ref": args.external_ref,
        "account_id": None,
        "checkout_session_id": None,
        "stripe_customer_id": None,
        "stripe_subscription_id": None,
        "database_state_available": False,
    }
    try:
        conn = await asyncpg.connect(args.database_url, timeout=3)
        try:
            row = await conn.fetchrow(
                """select a.id,a.stripe_customer_id,a.stripe_subscription_id,
                          c.session_id
                     from billing_accounts a
                     left join checkout_claims c on c.account_id=a.id
                    where a.external_ref=$1""",
                args.external_ref,
            )
            manifest["database_state_available"] = True
            if row is not None:
                manifest.update(
                    {
                        "account_id": str(row["id"]),
                        "checkout_session_id": row["session_id"],
                        "stripe_customer_id": row["stripe_customer_id"],
                        "stripe_subscription_id": row["stripe_subscription_id"],
                    }
                )
        finally:
            await conn.close()
    except (OSError, asyncpg.PostgresError):
        pass
    def _write() -> None:
        output = Path(args.output)
        output.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
        output.chmod(0o600)

    await asyncio.to_thread(_write)


async def verify_database(args: argparse.Namespace) -> None:
    conn = await asyncpg.connect(args.database_url)
    try:
        account = await conn.fetchrow(
            """select plan_key,plan_interval,subscription_status,credits_balance,
                      entitlement_revoked
                 from billing_accounts where external_ref=$1""",
            args.external_ref,
        )
        if account is None:
            raise RuntimeError("browser E2E account was not created")
        if tuple(account) != ("starter", "month", "active", 300, False):
            raise RuntimeError(f"unexpected browser E2E account projection: {tuple(account)!r}")
        events = await conn.fetch(
            """select id,event_type,outcome,payload->>'id' as payload_id,
                      payload->>'api_version' as api_version,livemode
                 from stripe_webhook_events
                where event_type=any($1::text[])""",
            list(SUPPORTED_EVENTS),
        )
        handled = {str(row["event_type"]) for row in events if row["outcome"] == "handled"}
        required = {"checkout.session.completed", "invoice.paid"}
        if not required.issubset(handled):
            raise RuntimeError(f"required webhook outcomes missing: {sorted(required - handled)}")
        stripe_event_api_versions: set[str] = set()
        for row in events:
            if row["payload_id"] != row["id"]:
                raise RuntimeError("stored webhook payload ID differs from its inbox key")
            if bool(row["livemode"]):
                raise RuntimeError("live Event reached the test E2E database")
            if row["api_version"] != args.event_api_version:
                raise RuntimeError(
                    "webhook payload version mismatch: "
                    f"{row['event_type']}={row['api_version']!r}"
                )
            remote = await asyncio.to_thread(
                stripe.Event.retrieve, str(row["id"]), **_options()
            )
            remote_raw = _dict(remote)
            if (
                remote_raw.get("id") != row["id"]
                or remote_raw.get("type") != row["event_type"]
                or bool(remote_raw.get("livemode")) != bool(row["livemode"])
            ):
                raise RuntimeError(
                    "stored signed payload identity/mode differs from Stripe Event truth"
                )
            stripe_event_api_versions.add(str(remote_raw.get("api_version") or "unset"))
        print(
            "verified signed webhook projection: "
            f"plan=starter/month credits=300 events={len(events)} "
            f"endpoint_payload_api_version={args.event_api_version} "
            "stripe_event_api_view_versions="
            f"{','.join(sorted(stripe_event_api_versions))}"
        )
    finally:
        await conn.close()


async def wait_database(args: argparse.Namespace) -> None:
    deadline = time.monotonic() + args.timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            conn = await asyncpg.connect(args.database_url, timeout=2)
            await conn.close()
            print("disposable PostgreSQL is reachable from the host")
            return
        except (OSError, asyncpg.PostgresError) as exc:
            last_error = exc
            await asyncio.sleep(0.25)
    raise RuntimeError("disposable PostgreSQL was not reachable before timeout") from last_error


async def _assert_declined_session(
    *, session_id: str, account_id: str
) -> None:
    session = await asyncio.to_thread(
        stripe.checkout.Session.retrieve, session_id, **_options()
    )
    raw = _dict(session)
    metadata = raw.get("metadata") or {}
    if (
        bool(raw.get("livemode"))
        or str(raw.get("client_reference_id")) != account_id
        or str(metadata.get("account_id")) != account_id
        or raw.get("mode") != "subscription"
        or raw.get("status") != "open"
        or raw.get("payment_status") != "unpaid"
        or _object_id(raw.get("subscription")) is not None
    ):
        raise RuntimeError("declined Checkout Session is not owned, open and unpaid")


async def verify_decline(args: argparse.Namespace) -> None:
    if args.stability_seconds < 10 or args.stability_seconds > 60:
        raise ValueError("stability seconds must be between 10 and 60")
    if not args.database_url or not args.external_ref:
        raise ValueError("decline barrier database URL and external ref are required")
    conn = await asyncpg.connect(args.database_url)
    try:
        identity = await conn.fetchrow(
            """select a.id,c.session_id
                 from billing_accounts a
                 join checkout_claims c on c.account_id=a.id
                where a.external_ref=$1""",
            args.external_ref,
        )
        if identity is None or not identity["session_id"]:
            raise RuntimeError("decline barrier cannot find the run's Checkout claim")
        account_id = str(identity["id"])
        session_id = str(identity["session_id"])
        await _assert_declined_session(session_id=session_id, account_id=account_id)

        deadline = time.monotonic() + args.stability_seconds
        while True:
            state = await conn.fetchrow(
                """select plan_key,plan_interval,subscription_status,credits_balance,
                          stripe_customer_id,stripe_subscription_id,
                          entitlement_revoked,credit_expires_at
                     from billing_accounts where id=$1::uuid""",
                account_id,
            )
            if state is None or tuple(state) != (
                "free",
                None,
                "none",
                0,
                None,
                None,
                False,
                None,
            ):
                raise RuntimeError("declined Checkout changed the account projection")
            ledger_count = await conn.fetchval(
                "select count(*) from credit_ledger where account_id=$1::uuid",
                account_id,
            )
            invoice_count = await conn.fetchval(
                "select count(*) from stripe_invoice_state where account_id=$1::uuid",
                account_id,
            )
            if ledger_count or invoice_count:
                raise RuntimeError("declined Checkout created a funding or credit effect")
            if time.monotonic() >= deadline:
                break
            await asyncio.sleep(0.5)

        claim_session = await conn.fetchval(
            """select session_id from checkout_claims
                 where account_id=$1::uuid""",
            account_id,
        )
        if str(claim_session) != session_id:
            raise RuntimeError("Checkout claim changed during the decline barrier")
        await _assert_declined_session(session_id=session_id, account_id=account_id)
        print(
            "verified decline stability: account=free credits=0 ledger=0 "
            "session=open/unpaid"
        )
    finally:
        await conn.close()


async def cleanup_account(args: argparse.Namespace) -> None:
    conn = await asyncpg.connect(args.database_url)
    try:
        row = await conn.fetchrow(
            """select a.id,a.stripe_customer_id,a.stripe_subscription_id,
                      c.session_id
                 from billing_accounts a
                 left join checkout_claims c on c.account_id=a.id
                where a.external_ref=$1""",
            args.external_ref,
        )
    finally:
        await conn.close()
    if row is None:
        return
    session_id = row["session_id"]
    subscription_id = row["stripe_subscription_id"]
    customer_id = row["stripe_customer_id"]
    owned_customer_id: str | None = None
    if not session_id:
        sessions = await asyncio.to_thread(
            stripe.checkout.Session.list, limit=100, **_options()
        )
        owned_sessions = []
        for candidate in sessions.data:
            raw = _dict(candidate)
            metadata = raw.get("metadata") or {}
            if (
                not bool(raw.get("livemode"))
                and str(raw.get("client_reference_id")) == str(row["id"])
                and str(metadata.get("account_id")) == str(row["id"])
            ):
                owned_sessions.append(str(raw["id"]))
        if len(owned_sessions) > 1:
            raise RuntimeError("multiple Checkout Sessions matched one E2E account")
        session_id = owned_sessions[0] if owned_sessions else None
    if session_id:
        try:
            session = await asyncio.to_thread(
                stripe.checkout.Session.retrieve, str(session_id), **_options()
            )
            raw = _dict(session)
            metadata = raw.get("metadata") or {}
            owned = (
                not bool(raw.get("livemode"))
                and str(raw.get("client_reference_id")) == str(row["id"])
                and str(metadata.get("account_id")) == str(row["id"])
            )
            if not owned:
                raise RuntimeError("refusing to expire a Checkout Session outside this E2E run")
            owned_customer_id = _object_id(raw.get("customer"))
            if customer_id is None and owned_customer_id:
                customer_id = owned_customer_id
            session_subscription_id = _object_id(raw.get("subscription"))
            if subscription_id is None and session_subscription_id:
                subscription_id = session_subscription_id
            if raw.get("status") == "open":
                await asyncio.to_thread(session.expire, **_options())
        except stripe.InvalidRequestError:
            pass
    if subscription_id:
        try:
            subscription = await asyncio.to_thread(
                stripe.Subscription.retrieve, str(subscription_id), **_options()
            )
            subscription_raw = _dict(subscription)
            metadata = subscription_raw.get("metadata") or {}
            subscription_customer_id = _object_id(subscription_raw.get("customer"))
            owned = (
                not bool(subscription_raw.get("livemode"))
                and str(metadata.get("account_id")) == str(row["id"])
                and metadata.get("product_line") == E2E_PRODUCT_LINE
                and subscription_customer_id is not None
                and (
                    customer_id is None
                    or subscription_customer_id == str(customer_id)
                )
                and (
                    owned_customer_id is None
                    or subscription_customer_id == owned_customer_id
                )
            )
            if not owned:
                raise RuntimeError("refusing to cancel a Subscription outside this E2E run")
            owned_customer_id = subscription_customer_id
            await asyncio.to_thread(subscription.cancel, **_options())
        except stripe.InvalidRequestError:
            pass
    customer_to_delete = str(customer_id) if customer_id else owned_customer_id
    if customer_to_delete:
        if owned_customer_id != customer_to_delete:
            raise RuntimeError("refusing to delete an unverified E2E Customer")
        try:
            customer = await asyncio.to_thread(
                stripe.Customer.retrieve, customer_to_delete, **_options()
            )
            customer_raw = _dict(customer)
            if bool(customer_raw.get("livemode")):
                raise RuntimeError("refusing to delete a live Customer")
            await asyncio.to_thread(customer.delete, **_options())
        except stripe.InvalidRequestError:
            pass


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Manage isolated Stripe browser E2E state")
    commands = root.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create-webhook")
    create.add_argument("--url", required=True)
    create.add_argument("--event-api-version", required=True)
    create.add_argument("--description", required=True)
    create.add_argument("--output", required=True)
    create.set_defaults(run=create_webhook)

    verify = commands.add_parser("verify-webhook")
    verify.add_argument("--endpoint-id", required=True)
    verify.add_argument("--url", required=True)
    verify.add_argument("--event-api-version", required=True)
    verify.set_defaults(run=verify_webhook)

    delete = commands.add_parser("delete-webhook")
    delete.add_argument("--endpoint-id", required=True)
    delete.add_argument("--description", required=True)
    delete.set_defaults(run=delete_webhook)

    sweep = commands.add_parser("delete-webhook-by-description")
    sweep.add_argument("--description", required=True)
    sweep.add_argument("--url", required=True)
    sweep.set_defaults(run=delete_webhook_by_description)

    manifest = commands.add_parser("write-cleanup-manifest")
    manifest.add_argument("--database-url", required=True)
    manifest.add_argument("--external-ref", required=True)
    manifest.add_argument("--endpoint-id", default="")
    manifest.add_argument("--description", required=True)
    manifest.add_argument("--url", required=True)
    manifest.add_argument("--output", required=True)
    manifest.set_defaults(run=write_cleanup_manifest)

    database = commands.add_parser("verify-database")
    database.add_argument("--database-url", required=True)
    database.add_argument("--external-ref", required=True)
    database.add_argument("--event-api-version", required=True)
    database.set_defaults(run=verify_database)

    wait = commands.add_parser("wait-database")
    wait.add_argument("--database-url", required=True)
    wait.add_argument("--timeout-seconds", type=int, default=60)
    wait.set_defaults(run=wait_database)

    decline = commands.add_parser("verify-decline")
    decline.add_argument("--database-url", default=os.environ.get("E2E_DATABASE_URL"))
    decline.add_argument("--external-ref", default=os.environ.get("E2E_EXTERNAL_REF"))
    decline.add_argument("--stability-seconds", type=int, default=10)
    decline.set_defaults(run=verify_decline)

    cleanup = commands.add_parser("cleanup-account")
    cleanup.add_argument("--database-url", required=True)
    cleanup.add_argument("--external-ref", required=True)
    cleanup.set_defaults(run=cleanup_account)
    return root


def main() -> None:
    args = parser().parse_args()
    result = args.run(args)
    if asyncio.iscoroutine(result):
        asyncio.run(result)


if __name__ == "__main__":
    main()
