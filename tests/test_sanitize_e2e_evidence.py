from __future__ import annotations

import os
from pathlib import Path

import pytest

from scripts.sanitize_e2e_evidence import (
    EvidenceSafetyError,
    sanitize_evidence_tree,
)


def test_sanitizes_reusable_credentials_without_touching_safe_context(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    log = evidence / "backend.log"
    log.write_bytes(
        b"safe-before\x00 "
        b"sk_test_1234567890abcdef "
        b"rk_live_abcdef1234567890 "
        b"whsec_1234567890abcdef "
        b"eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno "
        b"pi_123456789_secret_abcdef123456789 "
        b"postgresql://user:password@database.example.test/app "
        b"safe-after\n"
    )

    assert sanitize_evidence_tree(evidence.resolve()) == 6

    clean = log.read_bytes()
    assert clean.startswith(b"safe-before ")
    assert clean.endswith(b"safe-after\n")
    assert b"sk_test_" not in clean
    assert b"rk_live_" not in clean
    assert b"whsec_" not in clean
    assert b"eyJhbGci" not in clean
    assert b"_secret_" not in clean
    assert b"postgresql://" not in clean


def test_sanitizes_private_key_and_is_idempotent(tmp_path: Path) -> None:
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    key = evidence / "loopback.key"
    key.write_text(
        "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\n",
        encoding="utf-8",
    )
    key.chmod(0o600)

    assert sanitize_evidence_tree(evidence.resolve()) == 1
    assert sanitize_evidence_tree(evidence.resolve()) == 0
    assert "private-material" not in key.read_text(encoding="utf-8")
    assert key.stat().st_mode & 0o777 == 0o600


def test_preserves_binary_nul_outside_log_files(tmp_path: Path) -> None:
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    artifact = evidence / "screenshot.bin"
    artifact.write_bytes(b"image\x00bytes")

    assert sanitize_evidence_tree(evidence.resolve()) == 0
    assert artifact.read_bytes() == b"image\x00bytes"


def test_rejects_relative_root(tmp_path: Path) -> None:
    previous = Path.cwd()
    try:
        os.chdir(tmp_path)
        Path("evidence").mkdir()
        with pytest.raises(EvidenceSafetyError):
            sanitize_evidence_tree(Path("evidence"))
    finally:
        os.chdir(previous)


def test_rejects_symbolic_links(tmp_path: Path) -> None:
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    target = tmp_path / "outside.log"
    target.write_text("safe", encoding="utf-8")
    (evidence / "outside.log").symlink_to(target)

    with pytest.raises(EvidenceSafetyError):
        sanitize_evidence_tree(evidence.resolve())
