#!/usr/bin/env python3
"""Review the semantic content of every promotional-video scene.

The full-frame technical pass lives in ``review_promo_video.sh``. This companion samples
one representative frame from each intentional scene, runs local Tesseract OCR, and
verifies that the expected headline/badge survived scaling, cropping, and encoding.
It records only expected-token results, never raw payment-page OCR.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Scene:
    name: str
    seconds: float
    expected_groups: tuple[tuple[str, ...], ...]


SCENES = (
    Scene("title", 1.6, (("stripe", "entitlements", "fastapi"), ("open", "source"))),
    Scene(
        "landing",
        4.7,
        (("production", "minded", "stripe", "billing", "reference"), ("open", "source")),
    ),
    Scene(
        "catalog",
        7.7,
        (("explicit", "plans", "annual", "grants", "structured", "entitlements"),),
    ),
    Scene("annual-pricing", 10.7, (("monthly", "yearly", "pricing"),)),
    Scene("full-period-policy", 13.9, (("full", "period", "reset"), ("funded", "period"))),
    Scene(
        "account-truth",
        17.1,
        (("postgresql", "entitlement", "credit", "truth"),),
    ),
    Scene(
        "free-state",
        20.1,
        (("free", "zero", "credits", "access"), ("stripe", "test", "mode")),
    ),
    Scene(
        "decline",
        23.6,
        (("declined", "payment", "never", "grants", "entitlement"),),
    ),
    Scene(
        "checkout-3ds",
        26.5,
        (("secure", "authentication"), ("stripe", "test", "mode")),
    ),
    Scene(
        "starter-projection",
        29.4,
        (("signed", "webhook", "starter", "monthly", "credits"),),
    ),
    Scene(
        "prorated-delta",
        33.7,
        (("prorated", "delta", "entitlement", "credits"), ("700",)),
    ),
    Scene(
        "upgrade-3ds",
        37.0,
        (("secure", "authentication"), ("sca", "recovery", "paid", "entitlement")),
    ),
    Scene(
        "pro-projection",
        40.0,
        (("paid", "webhook", "pro", "monthly", "credits"), ("1000",)),
    ),
    Scene(
        "redirect-boundary",
        43.7,
        (("browser", "redirects", "never", "authorization"),),
    ),
    Scene(
        "outro",
        47.0,
        (("fromcsuzhou", "stripe", "entitlements", "fastapi"), ("community", "project")),
    ),
)


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n{result.stderr}"
        )
    return result


def _tokens(text: str) -> set[str]:
    normalized = text.lower().replace("1,000", "1000")
    return set(re.findall(r"[a-z0-9]+", normalized))


def _load_scenes(manifest: Path | None) -> tuple[Scene, ...]:
    if manifest is None:
        return SCENES
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    items = payload.get("scenes") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise RuntimeError("scene manifest must contain a scenes list")
    expected_names = [scene.name for scene in SCENES]
    actual_names = [str(item.get("name")) for item in items if isinstance(item, dict)]
    if actual_names != expected_names:
        raise RuntimeError("scene manifest names/order do not match the semantic review contract")
    seconds_by_name: dict[str, float] = {}
    for item in items:
        if not isinstance(item, dict):
            raise RuntimeError("scene manifest contains a non-object item")
        name = str(item["name"])
        seconds = float(item["seconds"])
        if seconds < 0:
            raise RuntimeError(f"scene {name!r} has a negative timestamp")
        seconds_by_name[name] = seconds
    return tuple(
        Scene(scene.name, seconds_by_name[scene.name], scene.expected_groups) for scene in SCENES
    )


def review(
    video: Path,
    report: Path,
    scenes: tuple[Scene, ...],
    scene_manifest: Path | None,
) -> None:
    for command in ("ffmpeg", "tesseract"):
        if shutil.which(command) is None:
            raise RuntimeError(f"missing required command: {command}")
    results: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="stripe-promo-scenes-") as directory:
        frame = Path(directory) / "frame.png"
        for scene in scenes:
            _run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{scene.seconds:.3f}",
                    "-i",
                    str(video),
                    "-frames:v",
                    "1",
                    "-y",
                    str(frame),
                ]
            )
            ocr = _run(["tesseract", str(frame), "stdout", "--psm", "6"]).stdout
            observed = _tokens(ocr)
            groups = []
            passed = True
            for expected in scene.expected_groups:
                missing = sorted(set(expected) - observed)
                groups.append({"expected": list(expected), "missing": missing})
                passed = passed and not missing
            results.append(
                {
                    "name": scene.name,
                    "seconds": scene.seconds,
                    "passed": passed,
                    "recognized_token_count": len(observed),
                    "groups": groups,
                }
            )

    payload = {
        "video": str(video),
        "scene_count": len(results),
        "scene_manifest": str(scene_manifest) if scene_manifest else None,
        "passed": all(bool(result["passed"]) for result in results),
        "scenes": results,
    }
    report.parent.mkdir(parents=True, exist_ok=True)
    report.with_suffix(".json").write_text(
        f"{json.dumps(payload, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    lines = [
        "# Promotional scene review",
        "",
        f"- Video: `{video}`",
        f"- Scenes reviewed: {len(results)}",
        f"- Scene manifest: `{scene_manifest}`"
        if scene_manifest
        else "- Scene manifest: built-in defaults",
        f"- Result: {'PASS' if payload['passed'] else 'FAIL'}",
        "",
        "| Scene | Time | Result | Missing expected tokens |",
        "| --- | ---: | --- | --- |",
    ]
    for result in results:
        missing = [
            token
            for group in result["groups"]  # type: ignore[union-attr]
            for token in group["missing"]
        ]
        lines.append(
            f"| {result['name']} | {float(result['seconds']):.1f}s | "
            f"{'PASS' if result['passed'] else 'FAIL'} | "
            f"{', '.join(missing) if missing else '—'} |"
        )
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    if not payload["passed"]:
        raise RuntimeError(f"one or more promo scenes failed semantic review; inspect {report}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("report", type=Path)
    parser.add_argument("--scene-manifest", type=Path)
    args = parser.parse_args()
    if not args.video.is_file():
        parser.error(f"video not found: {args.video}")
    scene_manifest = args.scene_manifest
    if scene_manifest is None:
        adjacent = args.video.with_name(f"{args.video.stem}-scenes.json")
        scene_manifest = adjacent if adjacent.is_file() else None
    if scene_manifest is not None and not scene_manifest.is_file():
        parser.error(f"scene manifest not found: {scene_manifest}")
    scenes = _load_scenes(scene_manifest)
    review(args.video, args.report, scenes, scene_manifest)
    print(f"scene review passed: {args.report}")


if __name__ == "__main__":
    main()
