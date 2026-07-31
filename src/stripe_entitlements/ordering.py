from __future__ import annotations

# Same-second ties are common. Money-backed/terminal facts outrank weaker projections.
EVENT_RANK: dict[str, int] = {
    "invoice.payment_failed": 10,
    "customer.subscription.updated": 20,
    "invoice.paid": 30,
    "customer.subscription.deleted": 40,
}


def event_wins(
    *, current_created: int, current_rank: int, event_created: int, event_rank: int
) -> bool:
    return (event_created, event_rank) > (current_created, current_rank)


def rank_for(event_type: str) -> int:
    return EVENT_RANK.get(event_type, 0)
