from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

Outcome = Literal["handled", "ignored", "replayed", "duplicate"]


@dataclass(frozen=True, slots=True)
class ProcessResult:
    outcome: Outcome
    reason: str | None = None
    account_id: str | None = None


@dataclass(frozen=True, slots=True)
class SubscriptionSnapshot:
    subscription_id: str
    status: str
    lookup_key: str | None
    current_period_end: datetime | None = None
    resolved_price: dict[str, Any] | None = None
    quantity: int | None = None
    items_complete: bool = True
