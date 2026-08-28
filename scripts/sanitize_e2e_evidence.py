#!/usr/bin/env python3
"""Remove reusable credentials from retained local E2E evidence."""

from __future__ import annotations

import argparse
import os
import re
import stat
import tempfile
from pathlib import Path


class EvidenceSafetyError(RuntimeError):
    """Raised when a retained evidence tree cannot be proven safe."""


_PATTERNS: tuple[tuple[re.Pattern[bytes], bytes], ...] = (
    (
        re.compile(rb"(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{12,}"),
        b"[redacted-stripe-api-key]",
    ),
    (re.compile(rb"whsec_[A-Za-z0-9_]{8,}"), b"[redacted-webhook-secret]"),
    (
        re.compile(rb"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
        b"[redacted-jwt]",
    ),
    (
        re.compile(
            rb"(?:pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+",
            re.IGNORECASE,
        ),
        b"[redacted-stripe-client-secret]",
    ),
    (
        re.compile(
            rb"(?:postgres(?:ql)?(?:\+[a-z0-9]+)?|mysql|mariadb|"
            rb"mongodb(?:\+srv)?|redis(?:s)?|amqp(?:s)?|cockroachdb)://"
            rb"[^\s\x00\"'<>]+",
            re.IGNORECASE,
        ),
        b"[redacted-database-dsn]",
    ),
    (
        re.compile(
            rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?"
            rb"-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
            re.DOTALL,
        ),
        b"[redacted-private-key]",
    ),
)


def _evidence_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise EvidenceSafetyError("retained evidence contains a symbolic link")
        if path.is_file():
            files.append(path)
    return files


def _replace_atomically(path: Path, data: bytes) -> None:
    mode = stat.S_IMODE(path.stat().st_mode)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".sanitized",
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def sanitize_evidence_tree(root: Path) -> int:
    """Redact known reusable secrets and verify the complete tree a second time."""

    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise EvidenceSafetyError("retained evidence root is not a safe absolute directory")

    sanitized_values = 0
    try:
        for path in _evidence_files(root):
            data = path.read_bytes()
            clean = data.replace(b"\x00", b"") if path.suffix == ".log" else data
            for pattern, replacement in _PATTERNS:
                clean, count = pattern.subn(replacement, clean)
                sanitized_values += count
            if clean != data:
                _replace_atomically(path, clean)

        for path in _evidence_files(root):
            data = path.read_bytes()
            if any(pattern.search(data) for pattern, _ in _PATTERNS):
                raise EvidenceSafetyError("retained evidence still contains a reusable credential")
    except OSError as error:
        raise EvidenceSafetyError("retained evidence could not be inspected") from error
    return sanitized_values


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Sanitize a private E2E evidence tree without printing matches."
    )
    parser.add_argument("--root", required=True, type=Path)
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        count = sanitize_evidence_tree(args.root)
    except EvidenceSafetyError:
        print("E2E evidence sanitization failed.", file=os.sys.stderr)
        return 1
    print(f"sanitized-sensitive-values={count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
