#!/usr/bin/env python3
"""Fail closed when coordinated release-version sources drift."""

from __future__ import annotations

import argparse
import json
import re
import tomllib
from pathlib import Path

_STABLE_VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")


def _read_json(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{path} must contain a JSON object")
    return value


def _required_string(value: object, source: str) -> str:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"{source} must contain a non-empty version string")
    return value


def _match_version(path: Path, pattern: str) -> str:
    match = re.search(pattern, path.read_text(encoding="utf-8"))
    if match is None:
        raise RuntimeError(f"cannot find release version in {path}")
    return match.group(1)


def collect_versions(root: Path) -> dict[str, str]:
    pyproject = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    uv_lock = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    locked_project_versions = [
        package["version"]
        for package in uv_lock["package"]
        if package["name"] == "stripe-entitlements-fastapi"
    ]
    if len(locked_project_versions) != 1:
        raise RuntimeError("uv.lock must contain exactly one project package")

    typescript_package = _read_json(root / "typescript/package.json")
    typescript_lock = _read_json(root / "typescript/package-lock.json")
    typescript_lock_packages = typescript_lock.get("packages")
    if not isinstance(typescript_lock_packages, dict):
        raise RuntimeError("typescript/package-lock.json has no packages object")
    typescript_lock_root = typescript_lock_packages.get("")
    if not isinstance(typescript_lock_root, dict):
        raise RuntimeError("typescript/package-lock.json has no root package")

    web_package = _read_json(root / "web/package.json")
    web_lock = _read_json(root / "web/package-lock.json")
    web_lock_packages = web_lock.get("packages")
    if not isinstance(web_lock_packages, dict):
        raise RuntimeError("web/package-lock.json has no packages object")
    web_lock_root = web_lock_packages.get("")
    linked_typescript = web_lock_packages.get("../typescript")
    if not isinstance(web_lock_root, dict) or not isinstance(linked_typescript, dict):
        raise RuntimeError("web/package-lock.json is missing a coordinated local package")

    versions = {
        "pyproject.toml": _required_string(pyproject["project"]["version"], "pyproject.toml"),
        "uv.lock": _required_string(locked_project_versions[0], "uv.lock"),
        "typescript/package.json": _required_string(
            typescript_package.get("version"), "typescript/package.json"
        ),
        "typescript/package-lock.json": _required_string(
            typescript_lock.get("version"), "typescript/package-lock.json"
        ),
        "typescript/package-lock.json#packages-root": _required_string(
            typescript_lock_root.get("version"),
            "typescript/package-lock.json root package",
        ),
        "web/package.json": _required_string(web_package.get("version"), "web/package.json"),
        "web/package-lock.json": _required_string(web_lock.get("version"), "web/package-lock.json"),
        "web/package-lock.json#packages-root": _required_string(
            web_lock_root.get("version"), "web/package-lock.json root package"
        ),
        "web/package-lock.json#typescript-link": _required_string(
            linked_typescript.get("version"), "web/package-lock.json TypeScript link"
        ),
    }
    text_versions = {
        "src/stripe_entitlements/__init__.py": r'__version__ = "([^"]+)"',
        "src/stripe_entitlements/app.py": (
            r'FastAPI\(title="Stripe Entitlements Reference", version="([^"]+)"\)'
        ),
        "scripts/browser_e2e_app.py": (
            r'FastAPI\(title="Stripe Entitlements Browser E2E Host", version="([^"]+)"\)'
        ),
        "typescript/src/doctor.ts": r'TYPESCRIPT_PACKAGE_VERSION = "([^"]+)"',
        "CITATION.cff": r"(?m)^version: ([^\s]+)$",
        "CHANGELOG.md": r"(?m)^## ([0-9]+\.[0-9]+\.[0-9]+) - [0-9]{4}-[0-9]{2}-[0-9]{2}$",
    }
    for filename, pattern in text_versions.items():
        versions[filename] = _match_version(root / filename, pattern)
    return versions


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("expected", nargs="?", help="expected stable tag version without v")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root (defaults to this script's parent repository)",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    versions = collect_versions(root)
    expected = args.expected or versions["pyproject.toml"]
    if _STABLE_VERSION.fullmatch(expected) is None:
        raise SystemExit(f"release version must be canonical stable SemVer: {expected!r}")
    mismatches = {name: value for name, value in versions.items() if value != expected}
    if mismatches:
        raise SystemExit(
            f"release version mismatch: expected {expected!r}, observed {mismatches!r}"
        )
    print(f"release-version-contract={expected} sources={len(versions)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
