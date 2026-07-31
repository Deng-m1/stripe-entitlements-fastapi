from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

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
