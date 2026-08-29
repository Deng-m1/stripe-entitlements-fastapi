"""Run Python credit operations against the TypeScript suite's disposable database."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import asyncpg

from stripe_entitlements.credits import (
    CreditService,
    CreditsUnavailableError,
    InsufficientCreditsError,
)


def _required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value or value != value.strip():
        raise RuntimeError(f"{name} is required")
    return value


async def _wait_for_release(path: Path) -> None:
    for _ in range(400):
        if await asyncio.to_thread(path.is_file):
            return
        await asyncio.sleep(0.025)
    raise TimeoutError("the cross-runtime test barrier was not released")


async def _main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"charge", "refund"}:
        raise RuntimeError("usage: python-credit-worker.py charge|refund")
    action = sys.argv[1]
    dsn = _required("CROSS_RUNTIME_DATABASE_URL")
    account_id = _required("CROSS_RUNTIME_ACCOUNT_ID")
    key_prefix = _required("CROSS_RUNTIME_KEY_PREFIX")
    amount = _required("CROSS_RUNTIME_AMOUNT")
    count = int(_required("CROSS_RUNTIME_COUNT"))
    same_key = _required("CROSS_RUNTIME_SAME_KEY") == "1"
    barrier = Path(_required("CROSS_RUNTIME_BARRIER_DIRECTORY"))
    if count < 1 or count > 40:
        raise RuntimeError("CROSS_RUNTIME_COUNT is outside the test bound")

    await asyncio.to_thread(
        barrier.joinpath("python-ready").write_text,
        "ready\n",
        encoding="utf-8",
    )
    await _wait_for_release(barrier / "release")
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=count)
    if pool is None:
        raise RuntimeError("asyncpg did not create a pool")
    service = CreditService(pool)

    async def invoke(index: int) -> str:
        key = key_prefix if same_key else f"{key_prefix}:{index}"
        try:
            if action == "charge":
                return (await service.charge(account_id, amount, key)).outcome
            return (await service.refund(key)).outcome
        except InsufficientCreditsError:
            return "insufficient"
        except CreditsUnavailableError:
            return "unavailable"

    try:
        outcomes = await asyncio.gather(*(invoke(index) for index in range(count)))
    finally:
        await pool.close()
    print(json.dumps({"outcomes": outcomes}, separators=(",", ":")))


if __name__ == "__main__":
    asyncio.run(_main())
