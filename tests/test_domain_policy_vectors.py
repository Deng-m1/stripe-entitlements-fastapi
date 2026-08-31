from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from stripe_entitlements.catalog import PlanCatalog
from stripe_entitlements.credit_amount import credit_atoms, credit_decimal
from stripe_entitlements.event_audit import redacted_event_snapshot
from stripe_entitlements.invoice_policy import (
    has_unsupported_invoice_adjustments,
    has_unsupported_invoice_payment_shape,
)
from stripe_entitlements.ordering import event_wins, rank_for
from stripe_entitlements.owner_reference import (
    InvalidOwnerReferenceError,
    validate_owner_external_ref,
)
from stripe_entitlements.portal_policy import portal_configuration_is_safe
from stripe_entitlements.price_policy import (
    catalog_one_time_price_matches,
    catalog_price_matches,
)
from stripe_entitlements.subscription_state import (
    spendable_subscription_atoms,
    subscription_credits_are_spendable,
)
from stripe_entitlements.transitions import decide_transition

_GOLDEN_PATH = Path(__file__).parent / "golden" / "domain-policy-vectors.json"


@pytest.fixture(scope="module")
def vectors() -> Mapping[str, Any]:
    parsed = json.loads(_GOLDEN_PATH.read_text(encoding="utf-8"))
    assert isinstance(parsed, dict)
    assert parsed["schemaVersion"] == 2
    return parsed


def _expected_kwargs(expected: Mapping[str, Any]) -> dict[str, Any]:
    names = {
        "expectedCurrency": "expected_currency",
        "expectedUnitAmount": "expected_unit_amount",
        "expectedInterval": "expected_interval",
        "expectedProductLine": "expected_product_line",
        "expectedPlanKey": "expected_plan_key",
        "expectedPackKey": "expected_pack_key",
        "expectedLookupKey": "expected_lookup_key",
        "expectedPriceId": "expected_price_id",
        "expectedLivemode": "expected_livemode",
    }
    return {names[key]: value for key, value in expected.items()}


def _timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def test_python_matches_shared_credit_amount_vectors(vectors: Mapping[str, Any]) -> None:
    for vector in vectors["creditAmounts"]:
        if not vector["valid"]:
            with pytest.raises(ValueError):
                credit_atoms(vector["input"])
            continue
        atoms = credit_atoms(vector["input"])
        assert str(atoms) == vector["atoms"], vector["name"]
        assert credit_decimal(atoms) == vector["canonical"], vector["name"]


def test_python_matches_shared_owner_reference_vectors(vectors: Mapping[str, Any]) -> None:
    for vector in vectors["ownerReferences"]:
        if not vector["valid"]:
            with pytest.raises(InvalidOwnerReferenceError):
                validate_owner_external_ref(vector["input"])
            continue
        assert validate_owner_external_ref(vector["input"]) == vector["input"], vector["name"]


def test_python_matches_shared_transition_vectors(
    vectors: Mapping[str, Any], catalog: PlanCatalog
) -> None:
    transitions = vectors["transitions"]
    states = transitions["states"]
    policies = transitions["policies"]
    assert len(states) == 6
    assert len(policies) == 2
    for policy_vector in policies:
        outcomes = policy_vector["outcomes"]
        assert len(outcomes) == len(states)
        for source_index, source in enumerate(states):
            assert len(outcomes[source_index]) == len(states)
            for target_index, target in enumerate(states):
                expected = outcomes[source_index][target_index]
                args = (
                    catalog.require(source["plan"]),
                    source["interval"],
                    catalog.require(target["plan"]),
                    target["interval"],
                    policy_vector["policy"],
                )
                if expected == "unsupported":
                    with pytest.raises(ValueError):
                        decide_transition(*args)
                else:
                    decision = decide_transition(
                        catalog.require(source["plan"]),
                        source["interval"],
                        catalog.require(target["plan"]),
                        target["interval"],
                        policy_vector["policy"],
                    )
                    assert decision.timing == expected
                    assert decision.policy == policy_vector["policy"]


def test_python_matches_shared_event_ordering_vectors(vectors: Mapping[str, Any]) -> None:
    for vector in vectors["eventOrdering"]:
        current = vector["current"]
        event = vector["event"]
        assert (
            event_wins(
                current_created=int(current["created"]),
                current_rank=rank_for(current["type"]),
                event_created=int(event["created"]),
                event_rank=rank_for(event["type"]),
            )
            is vector["wins"]
        ), vector["name"]


def test_python_matches_shared_invoice_policy_vectors(vectors: Mapping[str, Any]) -> None:
    for vector in vectors["invoiceAdjustments"]:
        assert (
            has_unsupported_invoice_adjustments(vector["invoice"], vector["lines"])
            is vector["unsupported"]
        ), vector["name"]
    for vector in vectors["invoicePayments"]:
        assert has_unsupported_invoice_payment_shape(vector["invoice"]) is vector["unsupported"], (
            vector["name"]
        )


def test_python_matches_shared_price_policy_vectors(vectors: Mapping[str, Any]) -> None:
    for vector in vectors["prices"]:
        expected = _expected_kwargs(vector["expected"])
        if vector["kind"] == "recurring":
            result = catalog_price_matches(vector["price"], **expected)
        else:
            result = catalog_one_time_price_matches(vector["price"], **expected)
        assert result is vector["matches"], vector["name"]


def test_python_matches_shared_portal_policy_vectors(vectors: Mapping[str, Any]) -> None:
    for vector in vectors["portalConfigurations"]:
        result = portal_configuration_is_safe(
            vector["config"], **_expected_kwargs(vector["expected"])
        )
        assert result is vector["safe"], vector["name"]


def test_python_matches_shared_subscription_vectors(vectors: Mapping[str, Any]) -> None:
    for vector in vectors["subscriptions"]:
        account = dict(vector["account"])
        account["credit_expires_at"] = _timestamp(account["credit_expires_at"])
        as_of = _timestamp(vector["asOf"])
        assert subscription_credits_are_spendable(account, as_of=as_of) is vector["spendable"], (
            vector["name"]
        )
        assert (
            str(spendable_subscription_atoms(account, as_of=as_of)) == vector["spendableAtoms"]
        ), vector["name"]


def test_python_matches_shared_event_audit_vectors(vectors: Mapping[str, Any]) -> None:
    for vector in vectors["eventAudits"]:
        assert redacted_event_snapshot(vector["event"]) == vector["snapshot"], vector["name"]
