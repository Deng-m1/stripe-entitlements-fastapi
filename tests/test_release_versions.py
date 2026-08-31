from __future__ import annotations

import sys
from pathlib import Path

import pytest

from scripts import check_release_versions


@pytest.mark.parametrize(
    "heading",
    [
        "## 0.4.0]",
        "## [Unreleased 0.4.0 - 2026-08-31",
        "## [Unreleased 0.4.0 - 2026-08-31]",
        "## 0.4.0",
    ],
)
def test_changelog_heading_rejects_crossed_or_incomplete_syntax(
    heading: str,
    tmp_path: Path,
) -> None:
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(f"# Changelog\n\n{heading}\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="invalid shape"):
        check_release_versions._changelog_heading(changelog)


@pytest.mark.parametrize(
    ("heading", "released"),
    [
        ("## [Unreleased 0.4.0]", False),
        ("## 0.4.0 - 2026-08-31", True),
    ],
)
def test_changelog_heading_accepts_only_the_two_documented_shapes(
    heading: str,
    released: bool,
    tmp_path: Path,
) -> None:
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(f"# Changelog\n\n{heading}\n", encoding="utf-8")

    assert check_release_versions._changelog_heading(changelog) == ("0.4.0", released)


def test_explicit_tag_version_requires_a_dated_changelog_heading(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text("# Changelog\n\n## [Unreleased 0.4.0]\n", encoding="utf-8")
    monkeypatch.setattr(
        check_release_versions,
        "collect_versions",
        lambda _root: {"pyproject.toml": "0.4.0", "CHANGELOG.md": "0.4.0"},
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["check_release_versions.py", "0.4.0", "--root", str(tmp_path)],
    )

    with pytest.raises(SystemExit, match="tag release requires"):
        check_release_versions.main()

    changelog.write_text("# Changelog\n\n## 0.4.0 - 2026-08-31\n", encoding="utf-8")
    assert check_release_versions.main() == 0
