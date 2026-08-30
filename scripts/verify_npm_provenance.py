#!/usr/bin/env python3
"""Verify that an npm SLSA attestation belongs to this exact release identity."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1"
GITHUB_ACTIONS_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1"
IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1"
IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json"
GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted"
COMMIT_PATTERN = re.compile(r"[0-9a-f]{40}")


def _mapping(value: object, description: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"npm provenance {description} must be an object")
    return value


def _decode_base64(value: str, description: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise RuntimeError(f"npm provenance {description} is not valid base64") from error


def verify_npm_provenance(
    document: object,
    *,
    package_name: str,
    version: str,
    integrity: str,
    expected_commit: str,
    tag_name: str,
    github_repository: str,
    workflow_path: str,
) -> None:
    if not integrity.startswith("sha512-"):
        raise RuntimeError("npm artifact integrity is not sha512")
    expected_digest_bytes = _decode_base64(integrity.removeprefix("sha512-"), "artifact integrity")
    if len(expected_digest_bytes) != 64:
        raise RuntimeError("npm artifact sha512 integrity has the wrong length")
    if COMMIT_PATTERN.fullmatch(expected_commit) is None:
        raise RuntimeError("expected Git commit must be 40 lowercase hexadecimal digits")
    if not package_name.startswith("@") or package_name.count("/") != 1:
        raise RuntimeError("expected npm package must be a scoped package")
    if not tag_name or not version or not github_repository or not workflow_path:
        raise RuntimeError("npm provenance release identity is incomplete")

    root = _mapping(document, "document")
    attestations = root.get("attestations")
    if not isinstance(attestations, list):
        raise RuntimeError("npm registry returned no attestation list")
    provenance = [
        item
        for item in attestations
        if isinstance(item, dict) and item.get("predicateType") == SLSA_PROVENANCE_V1
    ]
    if len(provenance) != 1:
        raise RuntimeError("npm registry must return exactly one SLSA provenance")

    bundle = _mapping(provenance[0].get("bundle"), "bundle")
    envelope = _mapping(bundle.get("dsseEnvelope"), "DSSE envelope")
    if envelope.get("payloadType") != IN_TOTO_PAYLOAD_TYPE:
        raise RuntimeError("npm provenance DSSE payload type drifted")
    payload_text = envelope.get("payload")
    if not isinstance(payload_text, str):
        raise RuntimeError("npm provenance has no DSSE payload")
    try:
        statement = _mapping(json.loads(_decode_base64(payload_text, "DSSE payload")), "statement")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("npm provenance DSSE payload is not valid JSON") from error

    if statement.get("_type") != IN_TOTO_STATEMENT_V1:
        raise RuntimeError("npm provenance statement type drifted")
    if statement.get("predicateType") != SLSA_PROVENANCE_V1:
        raise RuntimeError("npm provenance predicate type drifted")
    expected_subject = f"pkg:npm/{quote(package_name, safe='/')}@{version}"
    subjects = statement.get("subject")
    if not isinstance(subjects, list) or len(subjects) != 1:
        raise RuntimeError("npm provenance must contain exactly one subject")
    subject = _mapping(subjects[0], "subject")
    if subject.get("name") != expected_subject:
        raise RuntimeError("npm provenance subject package drifted")
    subject_digest = _mapping(subject.get("digest"), "subject digest")
    if subject_digest.get("sha512") != expected_digest_bytes.hex():
        raise RuntimeError("npm provenance subject digest drifted")

    predicate = _mapping(statement.get("predicate"), "predicate")
    build_definition = _mapping(predicate.get("buildDefinition"), "build definition")
    if build_definition.get("buildType") != GITHUB_ACTIONS_BUILD_TYPE:
        raise RuntimeError("npm provenance build type drifted")
    external_parameters = _mapping(
        build_definition.get("externalParameters"), "external parameters"
    )
    workflow = _mapping(external_parameters.get("workflow"), "workflow identity")
    expected_repository = f"https://github.com/{github_repository}"
    expected_ref = f"refs/tags/{tag_name}"
    if workflow != {
        "ref": expected_ref,
        "repository": expected_repository,
        "path": workflow_path,
    }:
        raise RuntimeError("npm provenance workflow identity drifted")

    dependencies = build_definition.get("resolvedDependencies")
    expected_uri = f"git+{expected_repository}@{expected_ref}"
    if not isinstance(dependencies, list) or not any(
        isinstance(dependency, dict)
        and dependency.get("uri") == expected_uri
        and isinstance(dependency.get("digest"), dict)
        and dependency["digest"].get("gitCommit") == expected_commit
        for dependency in dependencies
    ):
        raise RuntimeError("npm provenance commit identity drifted")

    run_details = _mapping(predicate.get("runDetails"), "run details")
    builder = _mapping(run_details.get("builder"), "builder")
    if builder.get("id") != GITHUB_HOSTED_BUILDER:
        raise RuntimeError("npm provenance builder identity drifted")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("attestations", type=Path)
    parser.add_argument("integrity")
    parser.add_argument("expected_commit")
    parser.add_argument("tag_name")
    parser.add_argument("github_repository")
    parser.add_argument("version")
    parser.add_argument("--package-name", default="@tosea/stripe-entitlements")
    parser.add_argument("--workflow-path", default=".github/workflows/release.yml")
    args = parser.parse_args()
    document = json.loads(args.attestations.read_text(encoding="utf-8"))
    verify_npm_provenance(
        document,
        package_name=args.package_name,
        version=args.version,
        integrity=args.integrity,
        expected_commit=args.expected_commit,
        tag_name=args.tag_name,
        github_repository=args.github_repository,
        workflow_path=args.workflow_path,
    )
    print(
        "npm-provenance-contract="
        f"{args.github_repository}@refs/tags/{args.tag_name}#{args.expected_commit}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
