from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from stripe_entitlements import scheduled
from stripe_entitlements.pack_reconcile import CreditPackReconcileResult
from stripe_entitlements.types import ProcessResult, SubscriptionSnapshot


class _Database:
    def require_pool(self) -> str:
        return "pool"


class _Gateway:
    async def subscription_snapshot(self, subscription_id: str) -> SubscriptionSnapshot:
        if subscription_id == "sub_remote_failure":
            raise RuntimeError("sk_test_secret_must_not_escape")
        return SubscriptionSnapshot(
            subscription_id=subscription_id,
            status="active",
            lookup_key="ent_starter_year",
            current_period_end=datetime(2027, 1, 1, tzinfo=UTC),
        )


async def test_annual_serverless_batch_is_bounded_and_returns_only_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[object] = []

    class FakeAnnualGrantService:
        def __init__(self, pool, catalog, processor):  # type: ignore[no-untyped-def]
            calls.append((pool, catalog, processor))

        async def due_accounts(self, now, *, limit):  # type: ignore[no-untyped-def]
            calls.append(("due", now, limit))
            return [
                {"id": "account-handled", "stripe_subscription_id": "sub_handled"},
                {"id": "account-replayed", "stripe_subscription_id": "sub_replayed"},
                {"id": "account-ignored", "stripe_subscription_id": "sub_ignored"},
                {"id": "account-failed", "stripe_subscription_id": "sub_remote_failure"},
            ]

        async def record_failure(self, account_id: str, subscription_id: str, reason: str) -> None:
            calls.append(("failure", account_id, subscription_id, reason))

        async def defer_candidate(self, account_id: str) -> None:
            calls.append(("defer", account_id))

        async def grant_due(
            self, account_id: str, now, snapshot: SubscriptionSnapshot
        ) -> ProcessResult:
            del now, snapshot
            outcome = account_id.removeprefix("account-")
            return ProcessResult(outcome)  # type: ignore[arg-type]

    monkeypatch.setattr(scheduled, "AnnualGrantService", FakeAnnualGrantService)
    kernel = SimpleNamespace(
        database=_Database(),
        catalog="catalog",
        gateway=_Gateway(),
        require_services=lambda: SimpleNamespace(processor="processor"),
    )

    result = await scheduled.run_annual_grant_batch(kernel, limit=7)  # type: ignore[arg-type]

    assert calls[1] == ("due", None, 7)
    assert ("defer", "account-ignored") in calls
    assert ("defer", "account-failed") in calls
    assert ("defer", "account-handled") not in calls
    assert ("defer", "account-replayed") not in calls
    assert result.public_summary() == {
        "ok": False,
        "attempted": 4,
        "handled": 1,
        "replayed": 1,
        "ignored": 1,
        "failures": 1,
    }
    rendered = repr(result.public_summary())
    assert "account-" not in rendered
    assert "sub_" not in rendered
    assert "sk_test_" not in rendered


async def test_reconciliation_serverless_batch_bounds_both_work_queues(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[object] = []
    run_started = datetime(2026, 8, 29, tzinfo=UTC)

    class FakeReconciliationService:
        def __init__(self, pool, processor, gateway):  # type: ignore[no-untyped-def]
            calls.append((pool, processor, gateway))

        async def database_now(self) -> datetime:
            return run_started

        async def candidates(self, now, *, limit, attempted_before):  # type: ignore[no-untyped-def]
            calls.append(("candidates", now, limit, attempted_before))
            return [{"id": "handled"}, {"id": "failed"}]

        async def reconcile_account(self, account_id: str) -> ProcessResult:
            if account_id == "failed":
                raise RuntimeError("private failure")
            return ProcessResult("handled", account_id=account_id)

    class FakePackService:
        async def reconcile_due(self, *, limit: int):  # type: ignore[no-untyped-def]
            calls.append(("packs", limit))
            return [
                CreditPackReconcileResult("pack-1", "reconciled"),
                CreditPackReconcileResult("pack-2", "idle"),
                CreditPackReconcileResult("pack-3", "lost_lease"),
                CreditPackReconcileResult("pack-4", "failed", error_code="private"),
            ]

    monkeypatch.setattr(scheduled, "ReconciliationService", FakeReconciliationService)
    kernel = SimpleNamespace(
        database=_Database(),
        catalog="catalog",
        gateway="gateway",
        require_services=lambda: SimpleNamespace(
            processor="processor",
            credit_pack_reconciliation=FakePackService(),
        ),
    )

    result = await scheduled.run_reconciliation_batch(  # type: ignore[arg-type]
        kernel,
        account_limit=9,
        credit_pack_limit=11,
    )

    assert ("candidates", None, 9, run_started) in calls
    assert ("packs", 11) in calls
    assert result.public_summary() == {
        "ok": False,
        "accounts_attempted": 2,
        "accounts_handled": 1,
        "accounts_replayed": 0,
        "accounts_ignored": 0,
        "packs_attempted": 4,
        "packs_reconciled": 1,
        "packs_idle": 1,
        "packs_deferred": 1,
        "failures": 2,
    }


@pytest.mark.parametrize("limit", [0, -1, 101, 1.5, True])
async def test_serverless_worker_limits_fail_closed_before_work(limit: object) -> None:
    kernel = SimpleNamespace()
    with pytest.raises(ValueError, match="between 1 and 100"):
        await scheduled.run_annual_grant_batch(kernel, limit=limit)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="between 1 and 100"):
        await scheduled.run_reconciliation_batch(  # type: ignore[arg-type]
            kernel,
            account_limit=limit,
        )
