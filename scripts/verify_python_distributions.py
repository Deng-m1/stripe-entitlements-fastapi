#!/usr/bin/env python3
"""Verify Python release artifacts contain exact canonical migrations and versions."""

from __future__ import annotations

import argparse
import email.parser
import tarfile
import tomllib
import zipfile
from pathlib import Path, PurePosixPath

_MIGRATIONS = (
    "001_v3_baseline.sql",
    "002_stripe_request_snapshots.sql",
)


def _exact_artifact(directory: Path, pattern: str) -> Path:
    matches = sorted(directory.glob(pattern))
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one {pattern} artifact, observed {matches!r}")
    return matches[0]


def _metadata_version(data: bytes, source: str) -> str:
    message = email.parser.BytesParser().parsebytes(data)
    version = message.get("Version")
    if not version:
        raise RuntimeError(f"{source} has no Version metadata")
    return version


def verify_wheel(path: Path, canonical: dict[str, bytes], expected_version: str) -> None:
    expected_name = f"stripe_entitlements_fastapi-{expected_version}-py3-none-any.whl"
    if path.name != expected_name:
        raise RuntimeError(f"wheel filename drifted: expected {expected_name!r}, got {path.name!r}")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        migration_prefix = "stripe_entitlements/migrations/"
        packaged = sorted(
            name.removeprefix(migration_prefix)
            for name in names
            if name.startswith(migration_prefix) and name.endswith(".sql")
        )
        if packaged != list(_MIGRATIONS):
            raise RuntimeError(f"wheel migration set drifted: {packaged!r}")
        for filename, expected in canonical.items():
            observed = archive.read(f"{migration_prefix}{filename}")
            if observed != expected:
                raise RuntimeError(f"wheel migration bytes drifted: {filename}")
        metadata = sorted(name for name in names if name.endswith(".dist-info/METADATA"))
        if len(metadata) != 1:
            raise RuntimeError(f"wheel metadata set drifted: {metadata!r}")
        observed_version = _metadata_version(archive.read(metadata[0]), str(path))
        if observed_version != expected_version:
            raise RuntimeError(
                f"wheel version drifted: expected {expected_version!r}, got {observed_version!r}"
            )


def verify_sdist(path: Path, canonical: dict[str, bytes], expected_version: str) -> None:
    expected_name = f"stripe_entitlements_fastapi-{expected_version}.tar.gz"
    if path.name != expected_name:
        raise RuntimeError(f"sdist filename drifted: expected {expected_name!r}, got {path.name!r}")
    with tarfile.open(path, "r:gz") as archive:
        file_members = [member for member in archive.getmembers() if member.isfile()]
        roots = {PurePosixPath(member.name).parts[0] for member in file_members}
        if len(roots) != 1:
            raise RuntimeError(f"sdist root set drifted: {sorted(roots)!r}")
        root = roots.pop()
        migration_prefix = f"{root}/migrations/"
        packaged_migrations = [
            member.name.removeprefix(migration_prefix)
            for member in file_members
            if member.name.startswith(migration_prefix) and member.name.endswith(".sql")
        ]
        if sorted(packaged_migrations) != list(_MIGRATIONS):
            raise RuntimeError(f"sdist migration set drifted: {sorted(packaged_migrations)!r}")
        migration_members = {
            member.name.removeprefix(migration_prefix): member
            for member in file_members
            if member.name.startswith(migration_prefix) and member.name.endswith(".sql")
        }
        for filename, expected in canonical.items():
            extracted = archive.extractfile(migration_members[filename])
            if extracted is None or extracted.read() != expected:
                raise RuntimeError(f"sdist migration bytes drifted: {filename}")
        metadata = next(
            (member for member in file_members if member.name == f"{root}/PKG-INFO"),
            None,
        )
        if metadata is None:
            raise RuntimeError("sdist has no root PKG-INFO")
        extracted_metadata = archive.extractfile(metadata)
        if extracted_metadata is None:
            raise RuntimeError("sdist PKG-INFO is unreadable")
        observed_version = _metadata_version(extracted_metadata.read(), str(path))
        if observed_version != expected_version:
            raise RuntimeError(
                f"sdist version drifted: expected {expected_version!r}, got {observed_version!r}"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="directory containing one wheel and one sdist")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root (defaults to this script's parent repository)",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    directory = args.directory.resolve()
    canonical_files = sorted(path.name for path in (root / "migrations").glob("*.sql"))
    if canonical_files != list(_MIGRATIONS):
        raise RuntimeError(f"canonical migration set drifted: {canonical_files!r}")
    canonical = {
        filename: (root / "migrations" / filename).read_bytes() for filename in _MIGRATIONS
    }
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    expected_version = project["project"]["version"]
    verify_wheel(_exact_artifact(directory, "*.whl"), canonical, expected_version)
    verify_sdist(_exact_artifact(directory, "*.tar.gz"), canonical, expected_version)
    print(f"python-distribution-contract={expected_version} migrations={','.join(_MIGRATIONS)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
