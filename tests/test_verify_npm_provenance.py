from __future__ import annotations

import base64
import copy
import json

import pytest

from scripts.verify_npm_provenance import verify_npm_provenance

PACKAGE_NAME = "@tosea/stripe-entitlements"
VERSION = "0.4.0"
TAG_NAME = "v0.4.0"
REPOSITORY = "Deng-m1/stripe-entitlements-fastapi"
WORKFLOW_PATH = ".github/workflows/release.yml"
COMMIT = "a" * 40
DIGEST = bytes(range(64))
INTEGRITY = "sha512-" + base64.b64encode(DIGEST).decode("ascii")


def _document() -> dict[str, object]:
    statement = {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [
            {
                "name": "pkg:npm/%40tosea/stripe-entitlements@0.4.0",
                "digest": {"sha512": DIGEST.hex()},
            }
        ],
        "predicateType": "https://slsa.dev/provenance/v1",
        "predicate": {
            "buildDefinition": {
                "buildType": (
                    "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1"
                ),
                "externalParameters": {
                    "workflow": {
                        "ref": "refs/tags/v0.4.0",
                        "repository": ("https://github.com/Deng-m1/stripe-entitlements-fastapi"),
                        "path": WORKFLOW_PATH,
                    }
                },
                "resolvedDependencies": [
                    {
                        "uri": (
                            "git+https://github.com/"
                            "Deng-m1/stripe-entitlements-fastapi@refs/tags/v0.4.0"
                        ),
                        "digest": {"gitCommit": COMMIT},
                    }
                ],
            },
            "runDetails": {"builder": {"id": "https://github.com/actions/runner/github-hosted"}},
        },
    }
    payload = base64.b64encode(json.dumps(statement, separators=(",", ":")).encode("utf-8")).decode(
        "ascii"
    )
    return {
        "attestations": [
            {
                "predicateType": "https://slsa.dev/provenance/v1",
                "bundle": {
                    "dsseEnvelope": {
                        "payloadType": "application/vnd.in-toto+json",
                        "payload": payload,
                        "signatures": [{"sig": "verified separately by npm"}],
                    }
                },
            }
        ]
    }


def _statement(document: dict[str, object]) -> dict[str, object]:
    attestations = document["attestations"]
    assert isinstance(attestations, list)
    attestation = attestations[0]
    assert isinstance(attestation, dict)
    bundle = attestation["bundle"]
    assert isinstance(bundle, dict)
    envelope = bundle["dsseEnvelope"]
    assert isinstance(envelope, dict)
    payload = envelope["payload"]
    assert isinstance(payload, str)
    statement = json.loads(base64.b64decode(payload))
    assert isinstance(statement, dict)
    return statement


def _replace_statement(document: dict[str, object], statement: dict[str, object]) -> None:
    attestations = document["attestations"]
    assert isinstance(attestations, list)
    attestation = attestations[0]
    assert isinstance(attestation, dict)
    bundle = attestation["bundle"]
    assert isinstance(bundle, dict)
    envelope = bundle["dsseEnvelope"]
    assert isinstance(envelope, dict)
    envelope["payload"] = base64.b64encode(
        json.dumps(statement, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")


def _verify(document: object, *, integrity: str = INTEGRITY) -> None:
    verify_npm_provenance(
        document,
        package_name=PACKAGE_NAME,
        version=VERSION,
        integrity=integrity,
        expected_commit=COMMIT,
        tag_name=TAG_NAME,
        github_repository=REPOSITORY,
        workflow_path=WORKFLOW_PATH,
    )


def test_accepts_exact_scoped_package_tag_workflow_commit_and_digest() -> None:
    _verify(_document())


@pytest.mark.parametrize(
    ("field", "replacement", "message"),
    [
        ("subject", "pkg:npm/%40other/package@0.4.0", "subject package"),
        ("digest", "00" * 64, "subject digest"),
        ("ref", "refs/heads/main", "workflow identity"),
        ("repository", "https://github.com/attacker/repository", "workflow identity"),
        ("path", ".github/workflows/other.yml", "workflow identity"),
        ("commit", "b" * 40, "commit identity"),
        ("builder", "https://attacker.example/builder", "builder identity"),
    ],
)
def test_rejects_release_identity_drift(field: str, replacement: str, message: str) -> None:
    document = _document()
    statement = _statement(document)
    predicate = statement["predicate"]
    assert isinstance(predicate, dict)
    build_definition = predicate["buildDefinition"]
    assert isinstance(build_definition, dict)
    if field == "subject":
        subjects = statement["subject"]
        assert isinstance(subjects, list) and isinstance(subjects[0], dict)
        subjects[0]["name"] = replacement
    elif field == "digest":
        subjects = statement["subject"]
        assert isinstance(subjects, list) and isinstance(subjects[0], dict)
        subjects[0]["digest"] = {"sha512": replacement}
    elif field in {"ref", "repository", "path"}:
        external = build_definition["externalParameters"]
        assert isinstance(external, dict)
        workflow = external["workflow"]
        assert isinstance(workflow, dict)
        workflow[field] = replacement
    elif field == "commit":
        dependencies = build_definition["resolvedDependencies"]
        assert isinstance(dependencies, list) and isinstance(dependencies[0], dict)
        dependencies[0]["digest"] = {"gitCommit": replacement}
    else:
        run_details = predicate["runDetails"]
        assert isinstance(run_details, dict)
        run_details["builder"] = {"id": replacement}
    _replace_statement(document, statement)
    with pytest.raises(RuntimeError, match=message):
        _verify(document)


def test_rejects_multiple_slsa_provenance_attestations() -> None:
    document = _document()
    attestations = document["attestations"]
    assert isinstance(attestations, list)
    attestations.append(copy.deepcopy(attestations[0]))
    with pytest.raises(RuntimeError, match="exactly one SLSA provenance"):
        _verify(document)


@pytest.mark.parametrize("integrity", ["sha256-deadbeef", "sha512-not-base64", "sha512-YQ=="])
def test_rejects_malformed_or_wrong_length_integrity(integrity: str) -> None:
    with pytest.raises(RuntimeError, match=r"integrity|sha512"):
        _verify(_document(), integrity=integrity)
