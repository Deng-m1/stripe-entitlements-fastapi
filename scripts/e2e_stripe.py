#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import os
import stat
import tempfile
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import asyncpg
import httpx
import stripe
from fastapi import FastAPI, Request, Response

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
    "payment_intent.succeeded",
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
    "credit_pack_order_id",
    "credit_pack_checkout_session_id",
    "credit_pack_payment_intent_id",
    "credit_pack_charge_id",
)
_MANIFEST_FIELDS = frozenset((*_MANIFEST_STRING_FIELDS, "database_state_available"))
_GATE_IDENTITY_FIELDS = frozenset(
    ("stripe_event_id", "account_id", "credit_pack_order_id", "pack_key")
)
_GATE_FILE_NAMES = {
    "account": "account.json",
    "armed": "armed.json",
    "captured": "captured.json",
    "released": "released.json",
    "forwarded": "forwarded.json",
}


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


def _verify_browser_job_debits(
    job_rows: list[Any],
    *,
    success_key: str,
    success_credits: CreditAmount,
    refunded_key: str,
    refunded_credits: CreditAmount,
) -> None:
    jobs = {str(row["idempotency_key"]): row for row in job_rows}
    if set(jobs) != {success_key, refunded_key}:
        raise RuntimeError("browser product Jobs did not create exactly two owner-bound debits")
    successful_job = jobs[success_key]
    refunded_job = jobs[refunded_key]
    if (
        int(successful_job["amount"]) != success_credits.atoms
        or int(successful_job["restored_credits"]) != 0
        or successful_job["refunded_at"] is not None
        or int(successful_job["allocated_credits"]) != success_credits.atoms
        or int(successful_job["allocation_refunds"]) != 0
        or list(successful_job["source_types"]) != ["subscription"]
    ):
        raise RuntimeError("successful browser product Job debit or provenance is invalid")
    if (
        int(refunded_job["amount"]) != refunded_credits.atoms
        or int(refunded_job["restored_credits"]) != refunded_credits.atoms
        or refunded_job["refunded_at"] is None
        or int(refunded_job["allocated_credits"]) != refunded_credits.atoms
        or int(refunded_job["allocation_refunds"]) != refunded_credits.atoms
        or list(refunded_job["source_types"]) != ["subscription"]
    ):
        raise RuntimeError("failed browser product Job did not converge through exact refund")


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


def _owned_pack_metadata_snapshot(
    metadata: object,
    *,
    account_id: str,
    order_id: str,
) -> tuple[str, str, int, str]:
    if not isinstance(metadata, dict):
        raise RuntimeError("credit-pack Stripe metadata is missing")
    required = {
        "billing_kind",
        "pack_schema_version",
        "product_line",
        "credit_pack_order_id",
        "account_id",
        "pack_key",
        "pack_credits",
        "price_amount",
        "currency",
        "expires_days",
        "lookup_key",
    }
    if not required.issubset(metadata):
        raise RuntimeError("credit-pack Stripe metadata snapshot is incomplete")
    price_text = metadata.get("price_amount")
    expires_text = metadata.get("expires_days")
    currency = metadata.get("currency")
    pack_key = metadata.get("pack_key")
    lookup_key = metadata.get("lookup_key")
    pack_credits = metadata.get("pack_credits")
    if (
        metadata.get("billing_kind") != "credit_pack"
        or metadata.get("pack_schema_version") != "1"
        or metadata.get("product_line") != E2E_PRODUCT_LINE
        or metadata.get("account_id") != account_id
        or metadata.get("credit_pack_order_id") != order_id
        or not isinstance(pack_key, str)
        or not isinstance(lookup_key, str)
        or lookup_key != f"ent_pack_{pack_key}"
        or not isinstance(pack_credits, str)
        or not isinstance(price_text, str)
        or not price_text.isascii()
        or not price_text.isdecimal()
        or price_text.startswith("0")
        or not isinstance(expires_text, str)
        or not expires_text.isascii()
        or not expires_text.isdecimal()
        or expires_text.startswith("0")
        or not isinstance(currency, str)
        or len(currency) != 3
        or not currency.isascii()
        or not currency.islower()
    ):
        raise RuntimeError("credit-pack Stripe metadata snapshot is conflicting")
    try:
        exact_pack_credits = _exact_credit_amount(
            pack_credits,
            field="credit-pack Stripe metadata credits",
        )
    except ValueError as exc:
        raise RuntimeError("credit-pack Stripe metadata credits are invalid") from exc
    if str(exact_pack_credits) != pack_credits:
        raise RuntimeError("credit-pack Stripe metadata credits are not canonical")
    price_amount = int(price_text)
    expires_days = int(expires_text)
    if price_amount <= 0 or not 1 <= expires_days <= 3650:
        raise RuntimeError("credit-pack Stripe metadata snapshot is outside safe bounds")
    return price_text, currency, price_amount, lookup_key


def _close_run_owned_pack_payment(
    *,
    account_id: str,
    order_id: str = "",
    session_id: str = "",
    payment_intent_id: str = "",
    charge_id: str = "",
    customer_id: str = "",
) -> dict[str, str]:
    """Close/refund one positively identified browser-E2E pack payment.

    Only non-secret object IDs cross this boundary. Mutable operations happen after
    Session, PaymentIntent, Charge, account, order, Customer, mode, and metadata agree.
    """

    resolved = {
        "order_id": order_id,
        "session_id": session_id,
        "payment_intent_id": payment_intent_id,
        "charge_id": charge_id,
        "customer_id": customer_id,
        "price_amount": "",
        "currency": "",
        "lookup_key": "",
    }
    if session_id:
        session = _retrieve_optional(stripe.checkout.Session.retrieve, session_id)
        if session is not None:
            raw = _dict(session)
            metadata = raw.get("metadata") or {}
            remote_order_id = str(metadata.get("credit_pack_order_id") or "")
            remote_payment_intent_id = _object_id(raw.get("payment_intent")) or ""
            remote_customer_id = _object_id(raw.get("customer")) or ""
            if (
                bool(raw.get("livemode"))
                or raw.get("mode") != "payment"
                or str(raw.get("client_reference_id")) != account_id
                or metadata.get("billing_kind") != "credit_pack"
                or metadata.get("pack_schema_version") != "1"
                or metadata.get("product_line") != E2E_PRODUCT_LINE
                or str(metadata.get("account_id")) != account_id
                or not remote_order_id
                or (order_id and remote_order_id != order_id)
                or (payment_intent_id and remote_payment_intent_id != payment_intent_id)
                or (customer_id and remote_customer_id != customer_id)
            ):
                raise RuntimeError("refusing to clean up an unowned credit-pack Session")
            price_text, currency, _, lookup_key = _owned_pack_metadata_snapshot(
                metadata,
                account_id=account_id,
                order_id=remote_order_id,
            )
            resolved.update(
                order_id=remote_order_id,
                payment_intent_id=remote_payment_intent_id,
                customer_id=remote_customer_id,
                price_amount=price_text,
                currency=currency,
                lookup_key=lookup_key,
            )
            if raw.get("status") == "open":
                expired = _dict(session.expire(**_options()))
                if expired.get("status") != "expired":
                    raise RuntimeError("run-owned credit-pack Session did not expire")
            _assert_checkout_session_closed(session_id, account_id)

    if resolved["payment_intent_id"]:
        intent = _retrieve_optional(
            stripe.PaymentIntent.retrieve,
            resolved["payment_intent_id"],
        )
        if intent is None:
            raise RuntimeError("run-owned credit-pack PaymentIntent disappeared")
        raw_intent = _dict(intent)
        metadata = raw_intent.get("metadata") or {}
        remote_charge_id = _object_id(raw_intent.get("latest_charge")) or ""
        remote_customer_id = _object_id(raw_intent.get("customer")) or ""
        if (
            bool(raw_intent.get("livemode"))
            or not remote_customer_id
            or (resolved["customer_id"] and remote_customer_id != resolved["customer_id"])
            or (charge_id and remote_charge_id != charge_id)
        ):
            raise RuntimeError("refusing to clean up an unowned credit-pack PaymentIntent")
        price_text, currency, price_amount, lookup_key = _owned_pack_metadata_snapshot(
            metadata,
            account_id=account_id,
            order_id=resolved["order_id"],
        )
        if (
            (resolved["price_amount"] and resolved["price_amount"] != price_text)
            or (resolved["currency"] and resolved["currency"] != currency)
            or (resolved["lookup_key"] and resolved["lookup_key"] != lookup_key)
            or raw_intent.get("status") != "succeeded"
            or raw_intent.get("amount") != price_amount
            or raw_intent.get("amount_received") != price_amount
            or raw_intent.get("currency") != currency
        ):
            raise RuntimeError("credit-pack PaymentIntent differs from its metadata snapshot")
        resolved.update(
            charge_id=remote_charge_id,
            customer_id=remote_customer_id,
            price_amount=price_text,
            currency=currency,
            lookup_key=lookup_key,
        )

    if resolved["charge_id"]:
        if not resolved["payment_intent_id"] or not resolved["order_id"]:
            raise RuntimeError("credit-pack Charge cleanup lacks verified payment lineage")
        charge = _retrieve_optional(stripe.Charge.retrieve, resolved["charge_id"])
        if charge is None:
            raise RuntimeError("run-owned credit-pack Charge disappeared")
        raw_charge = _dict(charge)
        amount = raw_charge.get("amount")
        amount_refunded = raw_charge.get("amount_refunded")
        if (
            bool(raw_charge.get("livemode"))
            or _object_id(raw_charge.get("payment_intent")) != resolved["payment_intent_id"]
            or _object_id(raw_charge.get("customer")) != resolved["customer_id"]
            or type(amount) is not int
            or type(amount_refunded) is not int
            or amount != int(resolved["price_amount"])
            or raw_charge.get("currency") != resolved["currency"]
            or amount <= 0
            or amount_refunded < 0
            or amount_refunded > amount
        ):
            raise RuntimeError("refusing to refund an unowned credit-pack Charge")
        if amount_refunded < amount:
            stripe.Refund.create(
                charge=resolved["charge_id"],
                amount=amount - amount_refunded,
                metadata={
                    "automated_test": "true",
                    "credit_pack_order_id": resolved["order_id"],
                },
                idempotency_key=f"browser-pack-cleanup:{resolved['order_id']}",
                **_options(),
            )
        final_charge = _dict(stripe.Charge.retrieve(resolved["charge_id"], **_options()))
        if (
            _object_id(final_charge.get("payment_intent")) != resolved["payment_intent_id"]
            or final_charge.get("amount_refunded") != final_charge.get("amount")
            or not bool(final_charge.get("refunded"))
        ):
            raise RuntimeError("run-owned credit-pack Charge retained refundable inventory")
    return resolved


def _require_isolated_event_inbox(total_events: int, run_events: int) -> int:
    unrelated_events = total_events - run_events
    if unrelated_events != 0:
        raise RuntimeError(
            "browser E2E webhook inbox contains "
            f"{unrelated_events} Event(s) outside this isolated run"
        )
    return unrelated_events


def _owned_checkout_kind(raw: dict[str, Any], account_id: str) -> str | None:
    """Classify only an exact run-owned subscription or credit-pack Session."""

    metadata = raw.get("metadata") or {}
    if (
        bool(raw.get("livemode"))
        or str(raw.get("client_reference_id")) != account_id
        or not isinstance(metadata, dict)
        or str(metadata.get("account_id")) != account_id
    ):
        return None
    billing_kind = metadata.get("billing_kind")
    if billing_kind == "credit_pack":
        return "credit_pack"
    if billing_kind is None:
        return "subscription"
    return None


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


def create_auth_fixture(args: argparse.Namespace) -> None:
    """Create short-lived local IdP credentials without persisting the private key."""

    personal_subject = args.personal_subject
    if (
        type(personal_subject) is not str
        or not personal_subject
        or personal_subject != personal_subject.strip()
        or len(personal_subject.encode("utf-8")) > 504
        or any(not character.isprintable() for character in personal_subject)
    ):
        raise ValueError("browser E2E Personal JWT subject must be a bounded visible string")
    try:
        parsed_workload_subject = uuid.UUID(args.workload_subject)
    except (AttributeError, ValueError) as exc:
        raise ValueError("browser E2E workload JWT subject must be a canonical UUID") from exc
    if parsed_workload_subject.int == 0 or str(parsed_workload_subject) != args.workload_subject:
        raise ValueError("browser E2E workload JWT subject must be a canonical nonzero UUID")
    workload_subject = str(parsed_workload_subject)
    for field, value in (
        ("issuer", args.issuer),
        ("personal audience", args.personal_audience),
        ("workload audience", args.workload_audience),
    ):
        if (
            type(value) is not str
            or not value
            or value != value.strip()
            or len(value.encode("utf-8")) > 2048
            or any(not character.isprintable() for character in value)
        ):
            raise ValueError(f"browser E2E JWT {field} is invalid")
    parsed_issuer = urlsplit(args.issuer)
    if (
        parsed_issuer.scheme != "https"
        or not parsed_issuer.netloc
        or parsed_issuer.username is not None
        or parsed_issuer.password is not None
        or parsed_issuer.fragment
    ):
        raise ValueError("browser E2E JWT issuer must be an HTTPS URL")
    if (
        type(args.email) is not str
        or args.email.count("@") != 1
        or args.email != args.email.strip()
        or len(args.email.encode("utf-8")) > 320
        or any(character.isspace() for character in args.email)
    ):
        raise ValueError("browser E2E Personal JWT email is invalid")

    # These are dev dependencies used only by this opt-in runner. Import lazily so
    # cleanup/recovery commands remain usable from the package's minimal runtime extra.
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_id = f"browser-e2e-{uuid.uuid4()}"
    public_jwk = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    public_jwk.update({"alg": "RS256", "kid": key_id, "use": "sig"})
    now = datetime.now(UTC)
    common_claims = {
        "iss": args.issuer,
        "nbf": int((now - timedelta(seconds=30)).timestamp()),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=2)).timestamp()),
    }
    personal_token = jwt.encode(
        {
            **common_claims,
            "aud": args.personal_audience,
            "sub": personal_subject,
            "email": args.email,
            "email_verified": True,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": key_id, "typ": "JWT"},
    )
    workload_token = jwt.encode(
        {
            **common_claims,
            "aud": args.workload_audience,
            "sub": workload_subject,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": key_id, "typ": "JWT"},
    )
    _write_private_json_atomic(Path(args.jwks_output), {"keys": [public_jwk]})
    _write_private_json_atomic(
        Path(args.token_output),
        {
            "personal_subject": personal_subject,
            "personal_token": personal_token,
            "workload_subject": workload_subject,
            "workload_token": workload_token,
        },
    )
    print("created ephemeral signed Personal JWT and workload JWT fixture")


def _private_gate_directory(raw_path: str, *, create: bool = False) -> Path:
    if not raw_path:
        raise RuntimeError("credit-pack webhook gate state directory is required")
    path = Path(raw_path).resolve()
    if create:
        path.mkdir(mode=0o700, parents=False, exist_ok=True)
    try:
        state = path.lstat()
    except FileNotFoundError as exc:
        raise RuntimeError("credit-pack webhook gate state directory does not exist") from exc
    if not stat.S_ISDIR(state.st_mode) or stat.S_IMODE(state.st_mode) & 0o077:
        raise RuntimeError("credit-pack webhook gate state directory must be private")
    return path


def _load_private_gate_json(path: Path, *, allowed_fields: frozenset[str]) -> dict[str, str]:
    try:
        state = path.lstat()
    except FileNotFoundError as exc:
        raise RuntimeError(f"credit-pack webhook gate state {path.name!r} is missing") from exc
    if not stat.S_ISREG(state.st_mode) or stat.S_IMODE(state.st_mode) & 0o077:
        raise RuntimeError("credit-pack webhook gate state file must be private and regular")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("credit-pack webhook gate state is invalid JSON") from exc
    if not isinstance(raw, dict) or set(raw) != allowed_fields:
        raise RuntimeError("credit-pack webhook gate state has an invalid field contract")
    if any(not isinstance(value, str) or not value for value in raw.values()):
        raise RuntimeError("credit-pack webhook gate state values must be non-empty strings")
    return {str(key): str(value) for key, value in raw.items()}


def _pack_gate_identity(payload: object, expected_account_id: str) -> dict[str, str] | None:
    """Return only non-sensitive correlation IDs for this run's pack payment Event."""

    if not isinstance(payload, dict) or payload.get("type") != "payment_intent.succeeded":
        return None
    if bool(payload.get("livemode")):
        return None
    event_id = payload.get("id")
    data = payload.get("data")
    obj = data.get("object") if isinstance(data, dict) else None
    metadata = obj.get("metadata") if isinstance(obj, dict) else None
    if (
        not isinstance(event_id, str)
        or not event_id.startswith("evt_")
        or not isinstance(metadata, dict)
        or metadata.get("billing_kind") != "credit_pack"
        or metadata.get("pack_schema_version") != "1"
        or metadata.get("account_id") != expected_account_id
        or obj.get("status") != "succeeded"
    ):
        return None
    order_id = metadata.get("credit_pack_order_id")
    pack_key = metadata.get("pack_key")
    try:
        normalized_order = str(uuid.UUID(str(order_id)))
        normalized_account = str(uuid.UUID(expected_account_id))
    except (AttributeError, TypeError, ValueError):
        return None
    if (
        not isinstance(pack_key, str)
        or not pack_key
        or len(pack_key.encode("utf-8")) > 64
        or any(
            not (character.islower() or character.isdigit() or character == "-")
            for character in pack_key
        )
    ):
        return None
    return {
        "stripe_event_id": event_id,
        "account_id": normalized_account,
        "credit_pack_order_id": normalized_order,
        "pack_key": pack_key,
    }


def arm_credit_pack_gate(args: argparse.Namespace) -> None:
    state_dir = _private_gate_directory(args.state_dir, create=True)
    try:
        account_id = str(uuid.UUID(args.account_id))
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("credit-pack webhook gate account id must be a UUID") from exc
    for key in ("captured", "released", "forwarded"):
        path = state_dir / _GATE_FILE_NAMES[key]
        if path.exists() or path.is_symlink():
            raise RuntimeError("credit-pack webhook gate state is not a fresh run directory")
    _write_private_json_atomic(state_dir / _GATE_FILE_NAMES["account"], {"account_id": account_id})
    _write_private_json_atomic(
        state_dir / _GATE_FILE_NAMES["armed"],
        {"account_id": account_id, "state": "armed"},
    )
    print("armed the run-owned credit-pack webhook barrier")


def release_credit_pack_gate(args: argparse.Namespace) -> None:
    state_dir = _private_gate_directory(args.state_dir)
    account = _load_private_gate_json(
        state_dir / _GATE_FILE_NAMES["account"],
        allowed_fields=frozenset(("account_id",)),
    )
    captured = _load_private_gate_json(
        state_dir / _GATE_FILE_NAMES["captured"],
        allowed_fields=_GATE_IDENTITY_FIELDS,
    )
    if captured["account_id"] != account["account_id"]:
        raise RuntimeError("captured credit-pack webhook belongs to another account")
    _write_private_json_atomic(
        state_dir / _GATE_FILE_NAMES["released"],
        {"account_id": account["account_id"], "stripe_event_id": captured["stripe_event_id"]},
    )
    print("released the run-owned credit-pack webhook barrier")


async def wait_credit_pack_gate(args: argparse.Namespace) -> None:
    if args.timeout_seconds < 1 or args.timeout_seconds > 120:
        raise ValueError("credit-pack webhook gate timeout must be between 1 and 120 seconds")
    state_dir = _private_gate_directory(args.state_dir)
    account = _load_private_gate_json(
        state_dir / _GATE_FILE_NAMES["account"],
        allowed_fields=frozenset(("account_id",)),
    )
    target = state_dir / _GATE_FILE_NAMES[args.phase]
    deadline = time.monotonic() + args.timeout_seconds
    while time.monotonic() < deadline:
        if target.exists():
            identity = _load_private_gate_json(target, allowed_fields=_GATE_IDENTITY_FIELDS)
            if identity["account_id"] != account["account_id"]:
                raise RuntimeError("credit-pack webhook gate phase belongs to another account")
            print(f"verified run-owned credit-pack webhook gate phase: {args.phase}")
            return
        await asyncio.sleep(0.05)
    raise RuntimeError(f"credit-pack webhook gate did not reach {args.phase!r} before timeout")


def create_webhook_gate() -> FastAPI:
    """Create a loopback proxy that pauses only the run's pack PI Event in memory."""

    state_dir = _private_gate_directory(os.environ.get("E2E_WEBHOOK_GATE_STATE_DIR", ""))
    backend_url = os.environ.get("E2E_WEBHOOK_GATE_BACKEND_URL", "")
    ca_file = os.environ.get("E2E_WEBHOOK_GATE_CA_FILE", "")
    try:
        backend = httpx.URL(backend_url)
    except Exception as exc:
        raise RuntimeError("credit-pack webhook gate backend URL is invalid") from exc
    if (
        backend.scheme != "https"
        or backend.host not in {"127.0.0.1", "localhost", "::1"}
        or backend.path != "/webhooks/stripe"
        or backend.query
    ):
        raise RuntimeError("credit-pack webhook gate backend must be the loopback HTTPS webhook")
    ca_path = Path(ca_file).resolve()
    if not ca_path.is_file():
        raise RuntimeError("credit-pack webhook gate CA file is missing")

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    async def gate_health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/ready")
    async def gate_ready() -> Response:
        health_url = backend.copy_with(path="/health", query=None)
        try:
            async with httpx.AsyncClient(verify=str(ca_path), timeout=5) as client:
                upstream = await client.get(str(health_url))
        except httpx.HTTPError:
            return Response(status_code=503)
        if upstream.status_code < 200 or upstream.status_code >= 300:
            return Response(status_code=503)
        return Response(content=b'{"ok":true}', media_type="application/json")

    @app.post("/webhooks/stripe")
    async def gate_webhook(request: Request) -> Response:
        signature = request.headers.get("stripe-signature", "")
        content_type = request.headers.get("content-type", "")
        if not signature or not content_type.startswith("application/json"):
            return Response(status_code=400)
        body = await request.body()
        if len(body) > 2 * 1024 * 1024:
            return Response(status_code=413)
        try:
            payload = json.loads(body)
        except (UnicodeError, json.JSONDecodeError):
            return Response(status_code=400)
        try:
            account = _load_private_gate_json(
                state_dir / _GATE_FILE_NAMES["account"],
                allowed_fields=frozenset(("account_id",)),
            )
        except RuntimeError:
            account = {}
        identity = _pack_gate_identity(payload, account.get("account_id", ""))
        if identity is not None and (state_dir / _GATE_FILE_NAMES["armed"]).exists():
            capture_path = state_dir / _GATE_FILE_NAMES["captured"]
            if capture_path.exists():
                existing = _load_private_gate_json(
                    capture_path,
                    allowed_fields=_GATE_IDENTITY_FIELDS,
                )
                if existing != identity:
                    return Response(status_code=409)
            else:
                _write_private_json_atomic(capture_path, identity)
            release_path = state_dir / _GATE_FILE_NAMES["released"]
            deadline = time.monotonic() + 12
            while (  # noqa: ASYNC110 - release is a cross-process filesystem signal.
                not release_path.exists() and time.monotonic() < deadline
            ):
                await asyncio.sleep(0.05)
            if not release_path.exists():
                # No payload is persisted. Stripe will retry this genuine Event after
                # the browser-side barrier is released.
                return Response(status_code=503)
            released = _load_private_gate_json(
                release_path,
                allowed_fields=frozenset(("account_id", "stripe_event_id")),
            )
            if (
                released["account_id"] != identity["account_id"]
                or released["stripe_event_id"] != identity["stripe_event_id"]
            ):
                return Response(status_code=409)
        try:
            async with httpx.AsyncClient(verify=str(ca_path), timeout=30) as client:
                upstream = await client.post(
                    str(backend),
                    content=body,
                    headers={
                        "content-type": content_type,
                        "stripe-signature": signature,
                    },
                )
        except httpx.HTTPError:
            return Response(status_code=502)
        if identity is not None and 200 <= upstream.status_code < 300:
            _write_private_json_atomic(
                state_dir / _GATE_FILE_NAMES["forwarded"],
                identity,
            )
        response_content_type = upstream.headers.get("content-type", "application/json")
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=response_content_type.split(";", 1)[0],
        )

    return app


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
        "credit_pack_order_id": None,
        "credit_pack_checkout_session_id": None,
        "credit_pack_payment_intent_id": None,
        "credit_pack_charge_id": None,
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
                          c.session_id,p.id as credit_pack_order_id,
                          p.stripe_checkout_session_id as credit_pack_checkout_session_id,
                          p.stripe_payment_intent_id as credit_pack_payment_intent_id,
                          p.stripe_charge_id as credit_pack_charge_id
                     from billing_accounts a
                     left join checkout_claims c on c.account_id=a.id
                     left join lateral (
                       select id,stripe_checkout_session_id,stripe_payment_intent_id,
                              stripe_charge_id
                         from credit_pack_orders
                        where account_id=a.id
                        order by created_at desc,id desc limit 1
                     ) p on true
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
                    "credit_pack_order_id": row.get("credit_pack_order_id"),
                    "credit_pack_checkout_session_id": row.get("credit_pack_checkout_session_id"),
                    "credit_pack_payment_intent_id": row.get("credit_pack_payment_intent_id"),
                    "credit_pack_charge_id": row.get("credit_pack_charge_id"),
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
    pack_credits = _exact_credit_amount(
        args.expected_pack_credits,
        field="expected browser E2E credit-pack credits",
    )
    success_job_credits = _exact_credit_amount(
        args.expected_success_job_credits,
        field="expected successful product Job credits",
    )
    refunded_job_credits = _exact_credit_amount(
        args.expected_refunded_job_credits,
        field="expected refunded product Job credits",
    )
    funded_total_atoms = (
        _exact_credit_amount("1000", field="Pro E2E credits").atoms + pack_credits.atoms
    )
    if credit_expectations.balance.atoms != funded_total_atoms - success_job_credits.atoms:
        raise ValueError(
            "expected final credits must equal Pro plus pack funding minus the successful Job"
        )
    subscription_balance_atoms = credit_expectations.balance.atoms - pack_credits.atoms
    if subscription_balance_atoms <= 0:
        raise ValueError("expected total credits must exceed expected credit-pack credits")
    if args.expected_pack_price < 1:
        raise ValueError("expected credit-pack price must be positive minor units")
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
            subscription_balance_atoms,
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

        pack_rows = await conn.fetch(
            """select o.id,o.account_id,o.pack_key,o.pack_credits,o.price_amount,
                      o.currency,o.expires_days,o.price_lookup_key,
                      o.checkout_status,o.payment_status,
                      o.stripe_checkout_session_id,o.stripe_payment_intent_id,
                      o.stripe_charge_id,o.stripe_customer_id,o.amount_paid,
                      o.amount_refunded,o.refunded_credits,
                      l.id as lot_id,l.order_id as lot_order_id,
                      l.account_id as lot_account_id,l.original_credits,
                      l.remaining_credits,l.expired_credits,
                      l.cash_clawed_back_credits,l.status as lot_status,
                      l.expires_at > now() as lot_unexpired,l.created_at as lot_created_at
                 from credit_pack_orders o
                 join credit_funding_lots l on l.order_id=o.id
                where o.account_id=$1::uuid
                order by o.created_at,o.id""",
            account_id,
        )
        if len(pack_rows) != 1:
            raise RuntimeError("browser E2E must project exactly one credit-pack order and lot")
        pack_row = pack_rows[0]
        pack_order_id = str(pack_row["id"])
        pack_session_id = str(pack_row["stripe_checkout_session_id"] or "")
        pack_payment_intent_id = str(pack_row["stripe_payment_intent_id"] or "")
        pack_charge_id = str(pack_row["stripe_charge_id"] or "")
        expected_pack_projection = (
            account_id,
            args.expected_pack,
            pack_credits.atoms,
            args.expected_pack_price,
            args.expected_pack_currency,
            args.expected_pack_expires_days,
            args.expected_pack_lookup_key,
            "completed",
            "paid",
        )
        actual_pack_projection = (
            str(pack_row["account_id"]),
            pack_row["pack_key"],
            int(pack_row["pack_credits"]),
            int(pack_row["price_amount"]),
            pack_row["currency"],
            int(pack_row["expires_days"]),
            pack_row["price_lookup_key"],
            pack_row["checkout_status"],
            pack_row["payment_status"],
        )
        if actual_pack_projection != expected_pack_projection:
            raise RuntimeError("credit-pack order differs from the exact browser purchase")
        if (
            not pack_session_id.startswith("cs_test_")
            or not pack_payment_intent_id.startswith("pi_")
            or not pack_charge_id.startswith("ch_")
            or pack_row["stripe_customer_id"] != customer_id
            or int(pack_row["amount_paid"] or 0) != args.expected_pack_price
            or int(pack_row["amount_refunded"]) != 0
            or int(pack_row["refunded_credits"]) != 0
            or str(pack_row["lot_order_id"]) != pack_order_id
            or str(pack_row["lot_account_id"]) != account_id
            or int(pack_row["original_credits"]) != pack_credits.atoms
            or int(pack_row["remaining_credits"]) != pack_credits.atoms
            or int(pack_row["expired_credits"]) != 0
            or int(pack_row["cash_clawed_back_credits"]) != 0
            or pack_row["lot_status"] != "active"
            or not bool(pack_row["lot_unexpired"])
        ):
            raise RuntimeError("credit-pack lot or Stripe lineage is incomplete")

        job_rows = await conn.fetch(
            """select d.idempotency_key,d.amount,d.restored_credits,d.refunded_at,
                      coalesce(sum(a.amount),0)::bigint as allocated_credits,
                      coalesce(sum(a.refunded_amount),0)::bigint as allocation_refunds,
                      coalesce(array_agg(distinct a.source_type)
                        filter (where a.source_type is not null),'{}'::text[]) as source_types
                 from credit_debits d
                 left join credit_debit_allocations a
                   on a.debit_idempotency_key=d.idempotency_key
                where d.account_id=$1::uuid and d.kind='usage'
                group by d.idempotency_key,d.amount,d.restored_credits,d.refunded_at
                order by d.idempotency_key""",
            account_id,
        )
        _verify_browser_job_debits(
            job_rows,
            success_key=args.expected_success_job_key,
            success_credits=success_job_credits,
            refunded_key=args.expected_refunded_job_key,
            refunded_credits=refunded_job_credits,
        )

        events = await conn.fetch(
            """select id,event_type,outcome,reason,processed_at,
                      payload->>'id' as payload_id,
                      payload->>'api_version' as api_version,livemode,
                      payload#>>'{data,object,id}' as object_id,
                      payload#>>'{data,object,client_reference_id}' as client_reference_id,
                      payload#>>'{data,object,metadata,billing_kind}' as billing_kind,
                      payload#>>'{data,object,metadata,credit_pack_order_id}' as pack_order_id,
                      payload#>>'{data,object,metadata,pack_key}' as pack_key,
                      payload#>>'{data,object,metadata,pack_credits}' as pack_credits,
                      payload#>>'{data,object,metadata,price_amount}' as pack_price_amount,
                      payload#>>'{data,object,metadata,currency}' as pack_currency,
                      payload#>>'{data,object,metadata,expires_days}' as pack_expires_days,
                      payload#>>'{data,object,metadata,lookup_key}' as pack_lookup_key,
                      payload#>>'{data,object,amount_received}' as amount_received,
                      payload#>>'{data,object,currency}' as currency,
                      payload#>>'{data,object,status}' as object_status,
                      payload#>>'{data,object,customer}' as object_customer,
                      payload#>>'{data,object,latest_charge}' as latest_charge,
                      payload#>>'{data,object,payment_intent}' as checkout_payment_intent
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
            and row["billing_kind"] != "credit_pack"
            and row["outcome"] == "handled"
        ]
        pack_checkout_events = [
            row
            for row in events
            if row["event_type"] == "checkout.session.completed"
            and row["object_id"] == pack_session_id
            and row["client_reference_id"] == account_id
            and row["billing_kind"] == "credit_pack"
            and row["outcome"] == "handled"
        ]
        pack_payment_events = [
            row
            for row in events
            if row["event_type"] == "payment_intent.succeeded"
            and row["object_id"] == pack_payment_intent_id
            and row["billing_kind"] == "credit_pack"
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
            len(checkout_events)
            == len(initial_paid_events)
            == len(settlement_paid_events)
            == len(pack_checkout_events)
            == len(pack_payment_events)
            == 1
        ):
            raise RuntimeError(
                "this E2E subject must have one subscription Checkout, two paid Invoices, "
                "one pack Checkout, and one authoritative pack PaymentIntent Event"
            )
        checkout_session_id = str(checkout_events[0]["object_id"] or "")
        if not checkout_session_id.startswith("cs_test_"):
            raise RuntimeError("handled Checkout Event is not bound to a test Session")
        pack_checkout = pack_checkout_events[0]
        pack_payment = pack_payment_events[0]
        if (
            pack_checkout["pack_order_id"] != pack_order_id
            or pack_checkout["pack_key"] != args.expected_pack
            or pack_checkout["pack_credits"] != str(pack_credits)
            or pack_checkout["pack_price_amount"] != str(args.expected_pack_price)
            or pack_checkout["pack_currency"] != args.expected_pack_currency
            or pack_checkout["pack_expires_days"] != str(args.expected_pack_expires_days)
            or pack_checkout["pack_lookup_key"] != args.expected_pack_lookup_key
            or pack_checkout["checkout_payment_intent"] != pack_payment_intent_id
            or pack_checkout["reason"]
            != "credit-pack Checkout recorded; payment webhook remains authoritative"
            or pack_payment["pack_order_id"] != pack_order_id
            or pack_payment["pack_key"] != args.expected_pack
            or pack_payment["pack_credits"] != str(pack_credits)
            or pack_payment["pack_price_amount"] != str(args.expected_pack_price)
            or pack_payment["pack_currency"] != args.expected_pack_currency
            or pack_payment["pack_expires_days"] != str(args.expected_pack_expires_days)
            or pack_payment["pack_lookup_key"] != args.expected_pack_lookup_key
            or pack_payment["amount_received"] != str(args.expected_pack_price)
            or pack_payment["currency"] != args.expected_pack_currency
            or pack_payment["object_status"] != "succeeded"
            or pack_payment["object_customer"] != customer_id
            or pack_payment["latest_charge"] != pack_charge_id
            or pack_payment["reason"] != "credit-pack funding granted"
            or pack_row["lot_created_at"] > pack_payment["processed_at"]
        ):
            raise RuntimeError(
                "credit-pack Checkout/PaymentIntent/lot lineage is not exact and authoritative"
            )
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
            str(pack_checkout["id"]),
            str(pack_payment["id"]),
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
            f"pack={args.expected_pack}/{pack_credits} pack_session_verified=true "
            f"job_charge={success_job_credits} job_refund={refunded_job_credits} "
            f"policy={args.transition_policy} account_events={len(events)} "
            f"unrelated_events={unrelated_events} essential_events=5 "
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
                      c.session_id,p.id as credit_pack_order_id,
                      p.stripe_checkout_session_id as credit_pack_checkout_session_id,
                      p.stripe_payment_intent_id as credit_pack_payment_intent_id,
                      p.stripe_charge_id as credit_pack_charge_id
                 from billing_accounts a
                 left join checkout_claims c on c.account_id=a.id
                 left join lateral (
                   select id,stripe_checkout_session_id,stripe_payment_intent_id,
                          stripe_charge_id
                     from credit_pack_orders
                    where account_id=a.id
                    order by created_at desc,id desc limit 1
                 ) p on true
                where a.external_ref=$1""",
            args.external_ref,
        )
    finally:
        await conn.close()
    if row is None:
        return
    account_id = str(row["id"])
    session_id = row["session_id"]
    subscription_id = row["stripe_subscription_id"]
    customer_id = row["stripe_customer_id"]
    owned_customer_id: str | None = None
    listed_sessions: list[Any] | None = None
    pack_order_id = str(row["credit_pack_order_id"] or "")
    pack_session_id = str(row["credit_pack_checkout_session_id"] or "")
    if pack_order_id and not pack_session_id:
        # Stripe may have committed Session creation before the application could
        # attach its ID. Discover only the exact account/order metadata snapshot;
        # complete auto-pagination keeps normal cleanup as strong as manifest recovery.
        listed_sessions = await asyncio.to_thread(
            _all_list_items,
            stripe.checkout.Session.list,
            limit=100,
            **_options(),
        )
        matching_pack_sessions: list[str] = []
        for candidate in listed_sessions:
            raw = _dict(candidate)
            metadata = raw.get("metadata") or {}
            candidate_id = _object_id(raw.get("id"))
            if (
                candidate_id
                and _owned_checkout_kind(raw, account_id) == "credit_pack"
                and isinstance(metadata, dict)
                and str(metadata.get("credit_pack_order_id")) == pack_order_id
            ):
                matching_pack_sessions.append(candidate_id)
        matching_pack_sessions = list(dict.fromkeys(matching_pack_sessions))
        if len(matching_pack_sessions) > 1:
            raise RuntimeError("multiple credit-pack Sessions matched one E2E order")
        pack_session_id = matching_pack_sessions[0] if matching_pack_sessions else ""
    pack_identity_present = any(
        row[field]
        for field in (
            "credit_pack_order_id",
            "credit_pack_checkout_session_id",
            "credit_pack_payment_intent_id",
            "credit_pack_charge_id",
        )
    )
    if pack_identity_present:
        resolved_pack = await asyncio.to_thread(
            _close_run_owned_pack_payment,
            account_id=account_id,
            order_id=pack_order_id,
            session_id=pack_session_id,
            payment_intent_id=str(row["credit_pack_payment_intent_id"] or ""),
            charge_id=str(row["credit_pack_charge_id"] or ""),
            customer_id=str(customer_id or ""),
        )
        pack_customer_id = resolved_pack["customer_id"] or None
        if customer_id is not None and pack_customer_id != str(customer_id):
            raise RuntimeError("credit-pack Customer conflicts with the E2E billing account")
        if customer_id is None and pack_customer_id:
            customer_id = pack_customer_id
        owned_customer_id = pack_customer_id
    if not session_id:
        sessions = listed_sessions
        if sessions is None:
            sessions = await asyncio.to_thread(
                _all_list_items,
                stripe.checkout.Session.list,
                limit=100,
                **_options(),
            )
        owned_sessions = []
        for candidate in sessions:
            raw = _dict(candidate)
            if _owned_checkout_kind(raw, account_id) == "subscription":
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
                and str(raw.get("client_reference_id")) == account_id
                and str(metadata.get("account_id")) == account_id
            )
            if not owned:
                raise RuntimeError("refusing to expire a Checkout Session outside this E2E run")
            session_customer_id = _object_id(raw.get("customer"))
            if owned_customer_id is not None and session_customer_id != owned_customer_id:
                raise RuntimeError("subscription and credit-pack Sessions use different Customers")
            owned_customer_id = session_customer_id
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
            account_id,
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
                and str(metadata.get("account_id")) == account_id
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
            account_id,
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
    pack_order_id = str(manifest.get("credit_pack_order_id") or "")
    pack_session_id = str(manifest.get("credit_pack_checkout_session_id") or "")
    pack_payment_intent_id = str(manifest.get("credit_pack_payment_intent_id") or "")
    pack_charge_id = str(manifest.get("credit_pack_charge_id") or "")
    endpoint_id = str(manifest.get("endpoint_id") or "")
    endpoint_description = str(manifest.get("endpoint_description") or "")
    endpoint_url = str(manifest.get("endpoint_url") or "")

    if (
        any(
            (
                session_id,
                customer_id,
                subscription_id,
                pack_order_id,
                pack_session_id,
                pack_payment_intent_id,
                pack_charge_id,
            )
        )
        and not account_id
    ):
        raise RuntimeError("cleanup manifest has Stripe account objects without account identity")

    owned_customer_id: str | None = None
    matching_sessions: list[Any] = []
    if account_id:
        explicit_session_ids = [
            candidate for candidate in (session_id, pack_session_id) if candidate
        ]
        for explicit_session_id in dict.fromkeys(explicit_session_ids):
            try:
                matching_sessions.append(
                    stripe.checkout.Session.retrieve(explicit_session_id, **_options())
                )
            except stripe.InvalidRequestError as exc:
                if not _is_missing_resource(exc):
                    raise
        discover_pack_session = (
            "credit_pack_checkout_session_id" in manifest and not pack_session_id
        )
        if not matching_sessions or discover_pack_session:
            sessions = _all_list_items(
                stripe.checkout.Session.list,
                limit=100,
                **_options(),
            )
            for candidate in sessions:
                raw = _dict(candidate)
                if _owned_checkout_kind(raw, account_id) is not None and str(raw.get("id")) not in {
                    str(_dict(item).get("id")) for item in matching_sessions
                }:
                    matching_sessions.append(candidate)
        subscription_sessions: list[Any] = []
        pack_sessions: list[Any] = []
        for candidate in matching_sessions:
            raw = _dict(candidate)
            metadata = raw.get("metadata") or {}
            if metadata.get("billing_kind") == "credit_pack":
                pack_sessions.append(candidate)
            else:
                subscription_sessions.append(candidate)
        if len(subscription_sessions) > 1 or len(pack_sessions) > 1:
            raise RuntimeError("multiple same-kind Checkout Sessions matched one recovery manifest")

        if pack_sessions or pack_payment_intent_id or pack_charge_id:
            discovered_pack_session_id = (
                str(_dict(pack_sessions[0])["id"]) if pack_sessions else pack_session_id
            )
            resolved_pack = _close_run_owned_pack_payment(
                account_id=account_id,
                order_id=pack_order_id,
                session_id=discovered_pack_session_id,
                payment_intent_id=pack_payment_intent_id,
                charge_id=pack_charge_id,
                customer_id=customer_id,
            )
            pack_customer_id = resolved_pack["customer_id"] or None
            if customer_id and pack_customer_id != customer_id:
                raise RuntimeError("cleanup manifest pack Customer conflicts with account identity")
            if not customer_id and pack_customer_id:
                customer_id = pack_customer_id
            owned_customer_id = pack_customer_id

        if subscription_sessions:
            session = subscription_sessions[0]
            raw = _dict(session)
            metadata = raw.get("metadata") or {}
            session_customer_id = _object_id(raw.get("customer"))
            owned = (
                not bool(raw.get("livemode"))
                and str(raw.get("client_reference_id")) == account_id
                and str(metadata.get("account_id")) == account_id
                and (not customer_id or session_customer_id == customer_id)
                and (owned_customer_id is None or session_customer_id == owned_customer_id)
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
    database.add_argument("--expected-credits", default="1100")
    database.add_argument("--expected-pack", default="boost-100")
    database.add_argument("--expected-pack-credits", default="100")
    database.add_argument("--expected-pack-price", type=int, default=1500)
    database.add_argument("--expected-pack-currency", default="usd")
    database.add_argument("--expected-pack-expires-days", type=int, default=365)
    database.add_argument("--expected-pack-lookup-key", default="ent_pack_boost-100")
    database.add_argument(
        "--expected-success-job-key",
        default="browser-e2e:job-success",
    )
    database.add_argument("--expected-success-job-credits", default="80")
    database.add_argument(
        "--expected-refunded-job-key",
        default="browser-e2e:job-failure",
    )
    database.add_argument("--expected-refunded-job-credits", default="20")
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

    gate_arm = commands.add_parser("arm-credit-pack-gate")
    gate_arm.add_argument("--state-dir", required=True)
    gate_arm.add_argument("--account-id", required=True)
    gate_arm.set_defaults(run=arm_credit_pack_gate)

    gate_wait = commands.add_parser("wait-credit-pack-gate")
    gate_wait.add_argument("--state-dir", required=True)
    gate_wait.add_argument("--phase", choices=("captured", "forwarded"), required=True)
    gate_wait.add_argument("--timeout-seconds", type=int, default=60)
    gate_wait.set_defaults(run=wait_credit_pack_gate)

    gate_release = commands.add_parser("release-credit-pack-gate")
    gate_release.add_argument("--state-dir", required=True)
    gate_release.set_defaults(run=release_credit_pack_gate)

    auth_fixture = commands.add_parser("create-auth-fixture")
    auth_fixture.add_argument("--issuer", required=True)
    auth_fixture.add_argument("--personal-audience", required=True)
    auth_fixture.add_argument("--personal-subject", required=True)
    auth_fixture.add_argument("--email", required=True)
    auth_fixture.add_argument("--workload-audience", required=True)
    auth_fixture.add_argument("--workload-subject", required=True)
    auth_fixture.add_argument("--jwks-output", required=True)
    auth_fixture.add_argument("--token-output", required=True)
    auth_fixture.set_defaults(run=create_auth_fixture)
    return root


def main() -> None:
    args = parser().parse_args()
    result = args.run(args)
    if asyncio.iscoroutine(result):
        asyncio.run(result)


if __name__ == "__main__":
    main()
