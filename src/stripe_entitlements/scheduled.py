from __future__ import annotations

from dataclasses import dataclass

from .annual import AnnualGrantService
from .kernel import BillingKernel
from .reconcile import ReconciliationService

_MAX_SERVERLESS_BATCH = 100


def _bounded_batch_limit(value: int, *, field: str) -> int:
    if type(value) is not int or value < 1 or value > _MAX_SERVERLESS_BATCH:
        raise ValueError(f"{field} must be an integer between 1 and {_MAX_SERVERLESS_BATCH}")
    return value


@dataclass(frozen=True, slots=True)
class AnnualGrantBatchResult:
    """Identity-free summary for one bounded annual-grant scheduler invocation."""

    attempted: int
    handled: int
    replayed: int
    ignored: int
    failures: int

    @property
    def ok(self) -> bool:
        return self.failures == 0

    def public_summary(self) -> dict[str, bool | int]:
        return {
            "ok": self.ok,
            "attempted": self.attempted,
            "handled": self.handled,
            "replayed": self.replayed,
            "ignored": self.ignored,
            "failures": self.failures,
        }


@dataclass(frozen=True, slots=True)
class ReconciliationBatchResult:
    """Identity-free summary for one bounded subscription and pack repair pass."""

    accounts_attempted: int
    accounts_handled: int
    accounts_replayed: int
    accounts_ignored: int
    packs_attempted: int
    packs_reconciled: int
    packs_idle: int
    packs_deferred: int
    failures: int

    @property
    def ok(self) -> bool:
        return self.failures == 0

    def public_summary(self) -> dict[str, bool | int]:
        return {
            "ok": self.ok,
            "accounts_attempted": self.accounts_attempted,
            "accounts_handled": self.accounts_handled,
            "accounts_replayed": self.accounts_replayed,
            "accounts_ignored": self.accounts_ignored,
            "packs_attempted": self.packs_attempted,
            "packs_reconciled": self.packs_reconciled,
            "packs_idle": self.packs_idle,
            "packs_deferred": self.packs_deferred,
            "failures": self.failures,
        }


async def run_annual_grant_batch(
    kernel: BillingKernel,
    *,
    limit: int = 25,
) -> AnnualGrantBatchResult:
    """Run at most ``limit`` annual candidates using the active kernel graph.

    The database row lock and invoice/slot uniqueness guard remain the concurrency
    authority. This wrapper deliberately processes only one page so it fits a bounded
    function invocation; a later scheduler tick safely continues the scan.
    """

    limit = _bounded_batch_limit(limit, field="annual grant batch limit")
    services = kernel.require_services()
    worker = AnnualGrantService(
        kernel.database.require_pool(),
        kernel.catalog,
        services.processor,
    )
    candidates = await worker.due_accounts(None, limit=limit)
    handled = replayed = ignored = failures = 0
    for candidate in candidates:
        account_id = str(candidate["id"])
        subscription_id = str(candidate["stripe_subscription_id"])
        try:
            snapshot = await kernel.gateway.subscription_snapshot(subscription_id)
        except Exception as exc:
            failures += 1
            try:
                await worker.record_failure(
                    account_id,
                    subscription_id,
                    f"subscription snapshot failed: {type(exc).__name__}",
                )
            except Exception:
                # A failed incident write must not stop later candidates. The non-zero
                # summary makes the scheduler retry this idempotent batch.
                pass
            try:
                await worker.defer_candidate(account_id)
            except Exception:
                pass
            continue
        try:
            result = await worker.grant_due(account_id, None, snapshot)
        except Exception:
            failures += 1
            continue
        if result.outcome == "handled":
            handled += 1
        elif result.outcome == "replayed":
            replayed += 1
        elif result.outcome == "ignored":
            ignored += 1
            try:
                await worker.defer_candidate(account_id)
            except Exception:
                failures += 1
        else:
            failures += 1
    return AnnualGrantBatchResult(
        attempted=len(candidates),
        handled=handled,
        replayed=replayed,
        ignored=ignored,
        failures=failures,
    )


async def run_reconciliation_batch(
    kernel: BillingKernel,
    *,
    account_limit: int = 20,
    credit_pack_limit: int = 20,
) -> ReconciliationBatchResult:
    """Run one bounded account-repair page and one fenced credit-pack page."""

    account_limit = _bounded_batch_limit(account_limit, field="reconciliation account batch limit")
    credit_pack_limit = _bounded_batch_limit(
        credit_pack_limit, field="credit-pack reconciliation batch limit"
    )
    services = kernel.require_services()
    worker = ReconciliationService(
        kernel.database.require_pool(),
        services.processor,
        kernel.gateway,
    )
    run_started = await worker.database_now()
    candidates = await worker.candidates(
        None,
        limit=account_limit,
        attempted_before=run_started,
    )
    handled = replayed = ignored = failures = 0
    for candidate in candidates:
        try:
            result = await worker.reconcile_account(str(candidate["id"]))
        except Exception:
            failures += 1
            continue
        if result.outcome == "handled":
            handled += 1
        elif result.outcome == "replayed":
            replayed += 1
        elif result.outcome == "ignored":
            ignored += 1
        else:
            failures += 1

    pack_results = await services.credit_pack_reconciliation.reconcile_due(limit=credit_pack_limit)
    packs_reconciled = sum(result.outcome == "reconciled" for result in pack_results)
    packs_idle = sum(result.outcome == "idle" for result in pack_results)
    packs_deferred = sum(result.outcome in {"lost_lease", "unavailable"} for result in pack_results)
    failures += sum(result.outcome == "failed" for result in pack_results)
    known_pack_outcomes = (
        packs_reconciled
        + packs_idle
        + packs_deferred
        + sum(result.outcome == "failed" for result in pack_results)
    )
    failures += len(pack_results) - known_pack_outcomes
    return ReconciliationBatchResult(
        accounts_attempted=len(candidates),
        accounts_handled=handled,
        accounts_replayed=replayed,
        accounts_ignored=ignored,
        packs_attempted=len(pack_results),
        packs_reconciled=packs_reconciled,
        packs_idle=packs_idle,
        packs_deferred=packs_deferred,
        failures=failures,
    )


__all__ = [
    "AnnualGrantBatchResult",
    "ReconciliationBatchResult",
    "run_annual_grant_batch",
    "run_reconciliation_batch",
]
