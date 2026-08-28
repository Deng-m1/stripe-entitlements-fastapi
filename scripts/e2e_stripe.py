#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import os
import stat
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import asyncpg
import stripe

from stripe_entitlements.credit_amount import CreditAmount

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
_MANIFEST_STRING_FIELDS = (
    "endpoint_id",
    "endpoint_description",
    "endpoint_url",
    "external_ref",
    "account_id",
    "checkout_session_id",
    "stripe_customer_id",
    "stripe_subscription_id",
)
_MANIFEST_FIELDS = frozenset((*_MANIFEST_STRING_FIELDS, "database_state_available"))


def _exact_credit_amount(value: object, *, field: str) -> CreditAmount:
    """Parse an E2E credit expectation without crossing a float boundary."""

    if type(value) is not str:
        raise ValueError(f"{field} must be an exact decimal string")
    return CreditAmount.parse(value, field=field, allow_zero=False)


@dataclass(frozen=True, slots=True)
class _BrowserCreditExpectations:
    balance: CreditAmount
    initial_grant_atoms: int
    settlement_reason: str
    settlement_grant_atoms: int
    allocation_atoms: int | None


def _browser_credit_expectations(
    expected_credits: object,
    transition_policy: str,
) -> _BrowserCreditExpectations:
    balance = _exact_credit_amount(
        expected_credits,
        field="expected browser E2E credits",
    )
    starter_atoms = _exact_credit_amount("300", field="Starter E2E credits").atoms
    pro_atoms = _exact_credit_amount("1000", field="Pro E2E credits").atoms
    delta_atoms = _exact_credit_amount("700", field="Pro upgrade E2E delta").atoms
    if transition_policy == "prorated_delta":
        return _BrowserCreditExpectations(
            balance,
            starter_atoms,
            "upgrade_delta_grant",
            delta_atoms,
            delta_atoms,
        )
    if transition_policy == "full_period_reset":
        return _BrowserCreditExpectations(
            balance,
            starter_atoms,
            "subscription_grant",
            pro_atoms,
            None,
        )
    raise ValueError("unknown browser E2E transition policy")


def _test_key() -> str:
    key = os.environ.get("STRIPE_SECRET_KEY", "")
    if not key.startswith("sk_test_"):
        raise RuntimeError("browser E2E refuses keys that do not start with sk_test_")
    return key


def _options() -> dict[str, Any]:
    return {
        "api_key": _test_key(),
        "stripe_version": os.environ.get("STRIPE_API_VERSION", "2026-06-24.dahlia"),
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


def _all_list_items(operation: Any, /, *args: Any, **kwargs: Any) -> list[Any]:
    page = operation(*args, **kwargs)
    iterator = getattr(page, "auto_paging_iter", None)
    return list(iterator()) if callable(iterator) else list(page.data)


def _is_missing_resource(exc: stripe.InvalidRequestError) -> bool:
    return exc.code == "resource_missing" or exc.http_status == 404


def _retrieve_optional(operation: Any, identifier: str) -> Any | None:
    try:
        return operation(identifier, **_options())
    except stripe.InvalidRequestError as exc:
        if _is_missing_resource(exc):
            return None
        raise


def _assert_checkout_session_closed(session_id: str, account_id: str) -> None:
    session = _retrieve_optional(stripe.checkout.Session.retrieve, session_id)
    if session is None:
        return
    raw = _dict(session)
    metadata = raw.get("metadata") or {}
    if (
        bool(raw.get("livemode"))
        or str(raw.get("client_reference_id")) != account_id
        or str(metadata.get("account_id")) != account_id
    ):
        raise RuntimeError("cleanup verification found an unowned Checkout Session")
    if raw.get("status") == "open":
        raise RuntimeError("run-owned Checkout Session remained open after cleanup")


def _assert_subscription_canceled(
    subscription_id: str,
    account_id: str,
    customer_id: str | None,
) -> None:
    subscription = _retrieve_optional(stripe.Subscription.retrieve, subscription_id)
    if subscription is None:
        return
    raw = _dict(subscription)
    metadata = raw.get("metadata") or {}
    actual_customer_id = _object_id(raw.get("customer"))
    if (
        bool(raw.get("livemode"))
        or str(metadata.get("account_id")) != account_id
        or metadata.get("product_line") != E2E_PRODUCT_LINE
        or actual_customer_id is None
        or (customer_id is not None and actual_customer_id != customer_id)
    ):
        raise RuntimeError("cleanup verification found an unowned Subscription")
    if raw.get("status") != "canceled":
        raise RuntimeError("run-owned Subscription remained active after cleanup")


def _assert_customer_deleted(customer_id: str) -> None:
    customer = _retrieve_optional(stripe.Customer.retrieve, customer_id)
    if customer is None:
        return
    raw = _dict(customer)
    if bool(raw.get("livemode")):
        raise RuntimeError("cleanup verification reached a live Customer")
    if not bool(raw.get("deleted")):
        raise RuntimeError("run-owned Customer remained present after cleanup")


def _require_isolated_event_inbox(total_events: int, run_events: int) -> int:
    unrelated_events = total_events - run_events
    if unrelated_events != 0:
        raise RuntimeError(
            "browser E2E webhook inbox contains "
            f"{unrelated_events} Event(s) outside this isolated run"
        )
    return unrelated_events


def _load_cleanup_manifest(output: Path) -> dict[str, Any]:
    try:
        state = output.lstat()
    except FileNotFoundError:
        return {}
    if not stat.S_ISREG(state.st_mode):
        raise RuntimeError("cleanup manifest must be a regular file")
    if stat.S_IMODE(state.st_mode) & 0o077:
        raise RuntimeError("cleanup manifest must not be readable by group or other users")
    try:
        raw = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("cleanup manifest is not valid UTF-8 JSON") from exc
    if not isinstance(raw, dict):
        raise RuntimeError("cleanup manifest must contain a JSON object")
    unknown_fields = sorted(set(raw) - _MANIFEST_FIELDS)
    if unknown_fields:
        raise RuntimeError(
            "cleanup manifest contains unsupported field(s): " + ", ".join(unknown_fields)
        )
    for field in _MANIFEST_STRING_FIELDS:
        value = raw.get(field)
        if value is not None and not isinstance(value, str):
            raise RuntimeError(f"cleanup manifest field {field!r} must be a string or null")
    database_state_available = raw.get("database_state_available")
    if database_state_available is not None and not isinstance(database_state_available, bool):
        raise RuntimeError("cleanup manifest database_state_available must be a boolean")
    return raw


def _write_private_json_atomic(output: Path, payload: dict[str, Any]) -> None:
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=output.parent,
        prefix=f".{output.name}.",
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            file_descriptor = -1
            json.dump(payload, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
        directory_descriptor = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if file_descriptor >= 0:
            os.close(file_descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _merge_manifest_identities(manifest: dict[str, Any], values: dict[str, Any]) -> None:
    for field, raw_value in values.items():
        if raw_value is None or raw_value == "":
            continue
        value = str(raw_value)
        existing = manifest.get(field)
        if existing not in (None, "", value):
            raise RuntimeError(f"cleanup manifest identity changed for {field}")
        manifest[field] = value


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
    except stripe.InvalidRequestError as exc:
        if _is_missing_resource(exc):
            return
        raise
    if bool(raw.get("livemode")):
        raise RuntimeError("refusing to delete a live webhook endpoint")
    if raw.get("description") != args.description:
        raise RuntimeError("refusing to delete an endpoint outside this E2E run")
    deleted = _dict(endpoint.delete(**_options()))
    if not bool(deleted.get("deleted")):
        raise RuntimeError("run-owned Webhook Endpoint did not delete")
    if _retrieve_optional(stripe.WebhookEndpoint.retrieve, args.endpoint_id) is not None:
        raise RuntimeError("run-owned Webhook Endpoint remained present after deletion")


def delete_webhook_by_description(args: argparse.Namespace) -> None:
    endpoints = _all_list_items(stripe.WebhookEndpoint.list, limit=100, **_options())
    matches = []
    for endpoint in endpoints:
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
        deleted = _dict(matches[0].delete(**_options()))
        if not bool(deleted.get("deleted")):
            raise RuntimeError("recovered Webhook Endpoint did not delete")


async def write_cleanup_manifest(args: argparse.Namespace) -> None:
    output = Path(args.output)
    manifest = await asyncio.to_thread(_load_cleanup_manifest, output)
    expected_identity = {
        "endpoint_description": args.description,
        "endpoint_url": args.url,
        "external_ref": args.external_ref,
    }
    for field, expected in expected_identity.items():
        existing = manifest.get(field)
        if existing not in (None, "", expected):
            raise RuntimeError(f"refusing to replace a cleanup manifest for another {field}")

    defaults: dict[str, Any] = {
        "endpoint_id": None,
        "endpoint_description": args.description,
        "endpoint_url": args.url,
        "external_ref": args.external_ref,
        "account_id": None,
        "checkout_session_id": None,
        "stripe_customer_id": None,
        "stripe_subscription_id": None,
        "database_state_available": False,
    }
    defaults.update(manifest)
    manifest = defaults
    manifest.update(expected_identity)
    _merge_manifest_identities(manifest, {"endpoint_id": args.endpoint_id})
    manifest["database_state_available"] = False
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
                database_identity = {
                    "account_id": str(row["id"]),
                    "checkout_session_id": row["session_id"],
                    "stripe_customer_id": row["stripe_customer_id"],
                    "stripe_subscription_id": row["stripe_subscription_id"],
                }
                _merge_manifest_identities(manifest, database_identity)
        finally:
            await conn.close()
    except (OSError, asyncpg.PostgresError):
        pass
    await asyncio.to_thread(_write_private_json_atomic, output, manifest)


async def verify_database(args: argparse.Namespace) -> None:
    credit_expectations = _browser_credit_expectations(
        args.expected_credits,
        args.transition_policy,
    )
    conn = await asyncpg.connect(args.database_url)
    try:
        account = await conn.fetchrow(
            """select id,stripe_customer_id,stripe_subscription_id,plan_key,
                      plan_interval,subscription_status,credits_balance,
                      entitlement_revoked
                 from billing_accounts where external_ref=$1""",
            args.external_ref,
        )
        if account is None:
            raise RuntimeError("browser E2E account was not created")
        expected = (
            args.expected_plan,
            "month",
            "active",
            credit_expectations.balance.atoms,
            False,
        )
        projection = tuple(account)[3:]
        if projection != expected:
            raise RuntimeError(f"unexpected browser E2E account projection: {projection!r}")
        account_id = str(account["id"])
        customer_id = str(account["stripe_customer_id"] or "")
        subscription_id = str(account["stripe_subscription_id"] or "")
        if not customer_id or not subscription_id:
            raise RuntimeError("browser E2E account is missing Stripe identity")

        changes = await conn.fetch(
            """select id,transition_policy,target_plan_key,target_interval,status,
                      settlement_invoice_id
                 from billing_plan_changes where account_id=$1::uuid""",
            account_id,
        )
        if len(changes) != 1 or tuple(changes[0])[1:5] != (
            args.transition_policy,
            "pro",
            "month",
            "completed",
        ):
            raise RuntimeError("browser plan-change intent did not complete exactly once")
        settlement_invoice_id = str(changes[0]["settlement_invoice_id"] or "")
        if not settlement_invoice_id:
            raise RuntimeError("browser plan change has no immutable settlement Invoice")

        grants = await conn.fetch(
            """select stripe_invoice_id,stripe_event_id,reason,entitlement_units
                 from credit_ledger
                where account_id=$1::uuid and grant_slot=1
                order by id""",
            account_id,
        )
        if len(grants) != 2:
            raise RuntimeError("browser E2E must create exactly two funded grant slots")
        initial_grants = [
            row for row in grants if row["stripe_invoice_id"] != settlement_invoice_id
        ]
        settlement_grants = [
            row for row in grants if row["stripe_invoice_id"] == settlement_invoice_id
        ]
        if (
            len(initial_grants) != 1
            or initial_grants[0]["reason"] != "subscription_grant"
            or int(initial_grants[0]["entitlement_units"])
            != credit_expectations.initial_grant_atoms
            or len(settlement_grants) != 1
        ):
            raise RuntimeError("browser E2E funding grants are ambiguous")
        initial_invoice_id = str(initial_grants[0]["stripe_invoice_id"] or "")
        if not initial_invoice_id or initial_invoice_id == settlement_invoice_id:
            raise RuntimeError("initial and upgrade settlement Invoices must be distinct")
        expected_settlement_grant = (
            credit_expectations.settlement_reason,
            credit_expectations.settlement_grant_atoms,
        )
        if (
            settlement_grants[0]["reason"],
            int(settlement_grants[0]["entitlement_units"]),
        ) != expected_settlement_grant:
            raise RuntimeError("settlement Invoice did not fund the selected policy")

        invoice_states = await conn.fetch(
            """select invoice_id,account_id from stripe_invoice_state
                where invoice_id=any($1::text[])""",
            [initial_invoice_id, settlement_invoice_id],
        )
        if len(invoice_states) != 2 or any(
            str(row["account_id"]) != account_id for row in invoice_states
        ):
            raise RuntimeError("funding Invoice state is not bound to this E2E account")

        allocations = await conn.fetch(
            """select transition_policy,target_plan_key,entitlement_delta,status,
                      stripe_invoice_id,source_invoice_id,stripe_event_id
                 from billing_funding_allocations where account_id=$1::uuid""",
            account_id,
        )
        if args.transition_policy == "prorated_delta":
            if len(allocations) != 1 or tuple(allocations[0])[:4] != (
                "prorated_delta",
                "pro",
                credit_expectations.allocation_atoms,
                "active",
            ):
                raise RuntimeError("browser delta funding allocation is missing or invalid")
            if (
                allocations[0]["stripe_invoice_id"] != settlement_invoice_id
                or allocations[0]["source_invoice_id"] != initial_invoice_id
            ):
                raise RuntimeError("browser delta allocation funding lineage is invalid")
        elif allocations:
            raise RuntimeError("full-period browser run unexpectedly created a delta allocation")

        events = await conn.fetch(
            """select id,event_type,outcome,payload->>'id' as payload_id,
                      payload->>'api_version' as api_version,livemode,
                      payload#>>'{data,object,id}' as object_id,
                      payload#>>'{data,object,client_reference_id}' as client_reference_id
                 from stripe_webhook_events
                where event_type=any($1::text[])
                  and (
                    payload#>>'{data,object,client_reference_id}'=$2
                    or payload#>>'{data,object,metadata,account_id}'=$2
                    or payload#>>'{data,object,parent,subscription_details,metadata,account_id}'=$2
                    or payload#>>'{data,object,subscription_details,metadata,account_id}'=$2
                    or payload#>>'{data,object,customer}'=$3
                    or payload#>>'{data,object,customer,id}'=$3
                    or payload#>>'{data,object,subscription}'=$4
                    or payload#>>'{data,object,subscription,id}'=$4
                    or payload#>>'{data,object,parent,subscription_details,subscription}'=$4
                    or payload#>>'{data,object,parent,subscription_details,subscription,id}'=$4
                    or (event_type like 'customer.subscription.%'
                        and payload#>>'{data,object,id}'=$4)
                  )""",
            list(SUPPORTED_EVENTS),
            account_id,
            customer_id,
            subscription_id,
        )
        checkout_events = [
            row
            for row in events
            if row["event_type"] == "checkout.session.completed"
            and row["client_reference_id"] == account_id
            and row["outcome"] == "handled"
        ]
        initial_paid_events = [
            row
            for row in events
            if row["event_type"] == "invoice.paid"
            and row["object_id"] == initial_invoice_id
            and row["outcome"] == "handled"
        ]
        settlement_paid_events = [
            row
            for row in events
            if row["event_type"] == "invoice.paid"
            and row["object_id"] == settlement_invoice_id
            and row["outcome"] == "handled"
        ]
        if not (
            len(checkout_events) == len(initial_paid_events) == len(settlement_paid_events) == 1
        ):
            raise RuntimeError(
                "this E2E subject must have one Checkout and two distinct handled paid Events"
            )
        checkout_session_id = str(checkout_events[0]["object_id"] or "")
        if not checkout_session_id.startswith("cs_test_"):
            raise RuntimeError("handled Checkout Event is not bound to a test Session")
        if initial_grants[0]["stripe_event_id"] != initial_paid_events[0]["id"]:
            raise RuntimeError("initial grant is not bound to its paid Event")
        if settlement_grants[0]["stripe_event_id"] != settlement_paid_events[0]["id"]:
            raise RuntimeError("settlement grant is not bound to its paid Event")
        if (
            args.transition_policy == "prorated_delta"
            and allocations[0]["stripe_event_id"] != settlement_paid_events[0]["id"]
        ):
            raise RuntimeError("delta allocation is not bound to its paid Event")

        essential_event_ids = [
            str(checkout_events[0]["id"]),
            str(initial_paid_events[0]["id"]),
            str(settlement_paid_events[0]["id"]),
        ]
        unresolved = await conn.fetchval(
            """select count(*) from billing_incidents
                where resolved_at is null and (
                  account_id=$1::uuid or invoice_id=any($2::text[])
                  or stripe_event_id=any($3::text[])
                )""",
            account_id,
            [initial_invoice_id, settlement_invoice_id],
            essential_event_ids,
        )
        if unresolved:
            raise RuntimeError("browser E2E account has unresolved billing incidents")

        stripe_event_api_versions: set[str] = set()
        for row in events:
            if row["payload_id"] != row["id"]:
                raise RuntimeError("stored webhook payload ID differs from its inbox key")
            if bool(row["livemode"]):
                raise RuntimeError("live Event reached the test E2E database")
            if row["api_version"] != args.event_api_version:
                raise RuntimeError(
                    f"webhook payload version mismatch: {row['event_type']}={row['api_version']!r}"
                )
            remote = await asyncio.to_thread(stripe.Event.retrieve, str(row["id"]), **_options())
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
        total_events = int(await conn.fetchval("select count(*) from stripe_webhook_events") or 0)
        unrelated_events = _require_isolated_event_inbox(total_events, len(events))
        print(
            "verified signed webhook projection: "
            f"plan={args.expected_plan}/month credits={credit_expectations.balance} "
            f"policy={args.transition_policy} account_events={len(events)} "
            f"unrelated_events={unrelated_events} essential_events=3 "
            f"signed_delivery_transport={args.delivery_transport} "
            f"signed_payload_api_version={args.event_api_version} "
            "stripe_event_api_view_versions="
            f"{','.join(sorted(stripe_event_api_versions))}"
        )
    finally:
        await conn.close()


async def prepare_upgrade_payment_method(args: argparse.Namespace) -> None:
    if not args.database_url or not args.external_ref:
        raise ValueError("upgrade PaymentMethod database URL and external ref are required")
    conn = await asyncpg.connect(args.database_url)
    try:
        row = await conn.fetchrow(
            """select id,stripe_customer_id,stripe_subscription_id
                 from billing_accounts where external_ref=$1""",
            args.external_ref,
        )
    finally:
        await conn.close()
    if row is None or not row["stripe_customer_id"] or not row["stripe_subscription_id"]:
        raise RuntimeError("browser E2E paid account is missing Stripe identity")
    if args.payment_method not in {
        "pm_card_authenticationRequired",
        "pm_card_visa",
    }:
        raise ValueError("upgrade PaymentMethod is not an allowlisted Stripe test fixture")
    account_id = str(row["id"])
    customer_id = str(row["stripe_customer_id"])
    subscription_id = str(row["stripe_subscription_id"])
    subscription = await asyncio.to_thread(
        stripe.Subscription.retrieve, subscription_id, **_options()
    )
    raw = _dict(subscription)
    metadata = raw.get("metadata") or {}
    if (
        bool(raw.get("livemode"))
        or _object_id(raw.get("customer")) != customer_id
        or str(metadata.get("account_id")) != account_id
        or str(metadata.get("product_line")) != E2E_PRODUCT_LINE
    ):
        raise RuntimeError("refusing to modify a Subscription outside this E2E run")
    payment_method = await asyncio.to_thread(
        stripe.PaymentMethod.attach,
        args.payment_method,
        customer=customer_id,
        **_options(),
    )
    await asyncio.to_thread(
        stripe.Customer.modify,
        customer_id,
        invoice_settings={"default_payment_method": payment_method.id},
        **_options(),
    )
    await asyncio.to_thread(
        stripe.Subscription.modify,
        subscription_id,
        default_payment_method=payment_method.id,
        **_options(),
    )
    print("prepared run-owned upgrade PaymentMethod")


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


async def resolve_account(args: argparse.Namespace) -> None:
    if not args.database_url or not args.external_ref:
        raise ValueError("account resolution database URL and external ref are required")
    conn = await asyncpg.connect(args.database_url)
    try:
        account_id = await conn.fetchval(
            "select id from billing_accounts where external_ref=$1",
            args.external_ref,
        )
    finally:
        await conn.close()
    if account_id is None:
        raise RuntimeError("authenticated E2E subject has no billing account")
    print(f"account-id={account_id}")


async def _assert_declined_session(*, session_id: str, account_id: str) -> None:
    session = await asyncio.to_thread(stripe.checkout.Session.retrieve, session_id, **_options())
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
        print("verified decline stability: account=free credits=0 ledger=0 session=open/unpaid")
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
            _all_list_items,
            stripe.checkout.Session.list,
            limit=100,
            **_options(),
        )
        owned_sessions = []
        for candidate in sessions:
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
                expired = _dict(await asyncio.to_thread(session.expire, **_options()))
                if expired.get("status") != "expired":
                    raise RuntimeError("run-owned Checkout Session did not expire")
        except stripe.InvalidRequestError as exc:
            if not _is_missing_resource(exc):
                raise
        await asyncio.to_thread(
            _assert_checkout_session_closed,
            str(session_id),
            str(row["id"]),
        )
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
                and (customer_id is None or subscription_customer_id == str(customer_id))
                and (owned_customer_id is None or subscription_customer_id == owned_customer_id)
            )
            if not owned:
                raise RuntimeError("refusing to cancel a Subscription outside this E2E run")
            owned_customer_id = subscription_customer_id
            canceled = _dict(await asyncio.to_thread(subscription.cancel, **_options()))
            if canceled.get("status") != "canceled":
                raise RuntimeError("run-owned Subscription did not cancel")
        except stripe.InvalidRequestError as exc:
            if not _is_missing_resource(exc):
                raise
        await asyncio.to_thread(
            _assert_subscription_canceled,
            str(subscription_id),
            str(row["id"]),
            str(customer_id) if customer_id else owned_customer_id,
        )
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
            deleted = _dict(await asyncio.to_thread(customer.delete, **_options()))
            if not bool(deleted.get("deleted")):
                raise RuntimeError("run-owned Customer did not delete")
        except stripe.InvalidRequestError as exc:
            if not _is_missing_resource(exc):
                raise
        await asyncio.to_thread(_assert_customer_deleted, customer_to_delete)


def recover_cleanup_manifest(args: argparse.Namespace) -> None:
    manifest_path = Path(args.manifest).resolve()
    manifest = _load_cleanup_manifest(manifest_path)
    account_id = str(manifest.get("account_id") or "")
    session_id = str(manifest.get("checkout_session_id") or "")
    customer_id = str(manifest.get("stripe_customer_id") or "")
    subscription_id = str(manifest.get("stripe_subscription_id") or "")
    endpoint_id = str(manifest.get("endpoint_id") or "")
    endpoint_description = str(manifest.get("endpoint_description") or "")
    endpoint_url = str(manifest.get("endpoint_url") or "")

    if any((session_id, customer_id, subscription_id)) and not account_id:
        raise RuntimeError("cleanup manifest has Stripe account objects without account identity")

    owned_customer_id: str | None = None
    matching_sessions: list[Any] = []
    if account_id:
        if session_id:
            try:
                matching_sessions.append(stripe.checkout.Session.retrieve(session_id, **_options()))
            except stripe.InvalidRequestError as exc:
                if not _is_missing_resource(exc):
                    raise
        if not matching_sessions:
            sessions = _all_list_items(
                stripe.checkout.Session.list,
                limit=100,
                **_options(),
            )
            for candidate in sessions:
                raw = _dict(candidate)
                metadata = raw.get("metadata") or {}
                if (
                    not bool(raw.get("livemode"))
                    and str(raw.get("client_reference_id")) == account_id
                    and str(metadata.get("account_id")) == account_id
                ):
                    matching_sessions.append(candidate)
        if len(matching_sessions) > 1:
            raise RuntimeError("multiple Checkout Sessions matched one recovery manifest")
        if matching_sessions:
            session = matching_sessions[0]
            raw = _dict(session)
            metadata = raw.get("metadata") or {}
            session_customer_id = _object_id(raw.get("customer"))
            owned = (
                not bool(raw.get("livemode"))
                and str(raw.get("client_reference_id")) == account_id
                and str(metadata.get("account_id")) == account_id
                and (not customer_id or session_customer_id == customer_id)
            )
            if not owned:
                raise RuntimeError("refusing to recover a Checkout Session outside this run")
            owned_customer_id = session_customer_id
            if not customer_id and session_customer_id:
                customer_id = session_customer_id
            session_subscription_id = _object_id(raw.get("subscription"))
            if not subscription_id and session_subscription_id:
                subscription_id = session_subscription_id
            if raw.get("status") == "open":
                expired = _dict(session.expire(**_options()))
                if expired.get("status") != "expired":
                    raise RuntimeError("recovered Checkout Session did not expire")
            _assert_checkout_session_closed(str(raw["id"]), account_id)

    if subscription_id:
        try:
            subscription = stripe.Subscription.retrieve(subscription_id, **_options())
            subscription_raw = _dict(subscription)
        except stripe.InvalidRequestError as exc:
            if not _is_missing_resource(exc):
                raise
            subscription = None
            subscription_raw = {}
        if subscription is not None:
            metadata = subscription_raw.get("metadata") or {}
            subscription_customer_id = _object_id(subscription_raw.get("customer"))
            owned = (
                not bool(subscription_raw.get("livemode"))
                and account_id
                and str(metadata.get("account_id")) == account_id
                and metadata.get("product_line") == E2E_PRODUCT_LINE
                and subscription_customer_id is not None
                and (not customer_id or subscription_customer_id == customer_id)
                and (owned_customer_id is None or subscription_customer_id == owned_customer_id)
            )
            if not owned:
                raise RuntimeError("refusing to recover a Subscription outside this run")
            owned_customer_id = subscription_customer_id
            if not customer_id:
                customer_id = subscription_customer_id
            if subscription_raw.get("status") != "canceled":
                canceled = _dict(subscription.cancel(**_options()))
                if canceled.get("status") != "canceled":
                    raise RuntimeError("recovered Subscription did not cancel")
            _assert_subscription_canceled(
                subscription_id,
                account_id,
                customer_id or owned_customer_id,
            )

    if customer_id:
        if owned_customer_id is not None and owned_customer_id != customer_id:
            raise RuntimeError("cleanup manifest Customer conflicts with verified ownership")
        if owned_customer_id is None:
            try:
                customer_probe = stripe.Customer.retrieve(customer_id, **_options())
                customer_probe_raw = _dict(customer_probe)
            except stripe.InvalidRequestError as exc:
                if not _is_missing_resource(exc):
                    raise
                customer_probe = None
                customer_probe_raw = {"deleted": True}
            if customer_probe is not None and not bool(customer_probe_raw.get("deleted")):
                raise RuntimeError(
                    "refusing to delete a Customer without a verified "
                    "run-owned Session or Subscription"
                )
        else:
            try:
                customer = stripe.Customer.retrieve(customer_id, **_options())
                customer_raw = _dict(customer)
            except stripe.InvalidRequestError as exc:
                if not _is_missing_resource(exc):
                    raise
                customer = None
                customer_raw = {"deleted": True}
            if customer is not None and not bool(customer_raw.get("deleted")):
                if bool(customer_raw.get("livemode")):
                    raise RuntimeError("refusing to delete a live Customer")
                deleted = _dict(customer.delete(**_options()))
                if not bool(deleted.get("deleted")):
                    raise RuntimeError("recovered Customer did not delete")
            _assert_customer_deleted(customer_id)

    if endpoint_id:
        delete_webhook(
            argparse.Namespace(
                endpoint_id=endpoint_id,
                description=endpoint_description,
            )
        )
    elif endpoint_description and endpoint_url.startswith("https://"):
        delete_webhook_by_description(
            argparse.Namespace(
                description=endpoint_description,
                url=endpoint_url,
            )
        )

    print("verified cleanup manifest: run-owned Stripe test objects are closed")


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
    database.add_argument(
        "--delivery-transport",
        choices=("endpoint", "stripe_cli"),
        default="endpoint",
    )
    database.add_argument("--expected-plan", default="pro")
    database.add_argument("--expected-credits", default="1000")
    database.add_argument(
        "--transition-policy",
        choices=("full_period_reset", "prorated_delta"),
        default="full_period_reset",
    )
    database.set_defaults(run=verify_database)

    upgrade = commands.add_parser("prepare-upgrade-payment-method")
    upgrade.add_argument("--database-url", default=os.environ.get("E2E_DATABASE_URL"))
    upgrade.add_argument("--external-ref", default=os.environ.get("E2E_EXTERNAL_REF"))
    upgrade.add_argument(
        "--payment-method",
        default=os.environ.get("E2E_UPGRADE_PAYMENT_METHOD", "pm_card_authenticationRequired"),
    )
    upgrade.set_defaults(run=prepare_upgrade_payment_method)

    wait = commands.add_parser("wait-database")
    wait.add_argument("--database-url", required=True)
    wait.add_argument("--timeout-seconds", type=int, default=60)
    wait.set_defaults(run=wait_database)

    account = commands.add_parser("resolve-account")
    account.add_argument("--database-url", default=os.environ.get("E2E_DATABASE_URL"))
    account.add_argument("--external-ref", default=os.environ.get("E2E_EXTERNAL_REF"))
    account.set_defaults(run=resolve_account)

    decline = commands.add_parser("verify-decline")
    decline.add_argument("--database-url", default=os.environ.get("E2E_DATABASE_URL"))
    decline.add_argument("--external-ref", default=os.environ.get("E2E_EXTERNAL_REF"))
    decline.add_argument("--stability-seconds", type=int, default=10)
    decline.set_defaults(run=verify_decline)

    cleanup = commands.add_parser("cleanup-account")
    cleanup.add_argument("--database-url", required=True)
    cleanup.add_argument("--external-ref", required=True)
    cleanup.set_defaults(run=cleanup_account)

    recover = commands.add_parser("recover-cleanup")
    recover.add_argument("--manifest", required=True)
    recover.set_defaults(run=recover_cleanup_manifest)
    return root


def main() -> None:
    args = parser().parse_args()
    result = args.run(args)
    if asyncio.iscoroutine(result):
        asyncio.run(result)


if __name__ == "__main__":
    main()
