#!/usr/bin/env python3
"""Locate recorded E2E milestones inside Playwright page videos.

Playwright records one file per page, and the order of ``video.webm`` / ``video-1.webm``
is not a stable page identity. This utility matches safe application screenshots against
low-resolution video frames, then uses the E2E timeline to derive the corresponding
Checkout, decline, and 3DS timestamps without inspecting or exporting payment data.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from collections import Counter
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Any

FRAME_WIDTH = 32
FRAME_HEIGHT = 18
FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT

SAFE_ANCHORS = {
    "Pricing page · Free account": "pricing-free",
    "Free account · zero credits": "free-account",
    "Webhook-backed Checkout success": "checkout-success",
    "Starter Monthly · 300 credits": "starter-300-credits",
    "Prorated delta · +700 entitlement credits": "prorated-delta-preview",
    "Full-period reset · new funded period": "full-period-preview",
    "Webhook-backed upgrade success": "upgrade-success",
    "Pro Monthly · 1,000 credits": "pro-1000-credits",
}

PRIMARY_SEED_LABELS = {
    "Webhook-backed Checkout success",
    "Pro Monthly · 1,000 credits",
}

SECONDARY_SEED_LABELS = {
    "Free account · zero credits",
    "Starter Monthly · 300 credits",
    "Prorated delta · +700 entitlement credits",
    "Full-period reset · new funded period",
    "Webhook-backed upgrade success",
}

PRIMARY_LABELS = {
    "Pricing page · Free account",
    "Real Stripe test Checkout",
    "Declined payment · access unchanged",
    "Checkout 3DS challenge",
    "Webhook-backed Checkout success",
    "Pro Monthly · 1,000 credits",
}

SECONDARY_LABELS = {
    "Free account · zero credits",
    "Starter Monthly · 300 credits",
    "Prorated delta · +700 entitlement credits",
    "Full-period reset · new funded period",
    "Upgrade 3DS challenge",
    "Webhook-backed upgrade success",
}


@dataclass(frozen=True)
class VideoFrames:
    path: Path
    duration: float
    fps: int
    frames: tuple[bytes, ...]


@dataclass(frozen=True)
class Match:
    label: str
    screenshot: Path
    video: Path
    seconds: float
    mean_absolute_error: float


def _run(command: list[str]) -> bytes:
    result = subprocess.run(command, check=False, capture_output=True)
    if result.returncode:
        stderr = result.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{stderr}")
    return result.stdout


def _duration(path: Path) -> float:
    output = _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(path),
        ]
    )
    return float(output.decode().strip())


def _decode_video(path: Path, fps: int) -> VideoFrames:
    raw = _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-vf",
            f"fps={fps},scale={FRAME_WIDTH}:{FRAME_HEIGHT}:flags=area,format=gray",
            "-an",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ]
    )
    if not raw or len(raw) % FRAME_BYTES:
        raise RuntimeError(f"invalid decoded frame stream for {path}")
    frames = tuple(raw[offset : offset + FRAME_BYTES] for offset in range(0, len(raw), FRAME_BYTES))
    return VideoFrames(path=path, duration=_duration(path), fps=fps, frames=frames)


def _decode_screenshot(path: Path) -> bytes:
    raw = _run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-vf",
            f"scale={FRAME_WIDTH}:{FRAME_HEIGHT}:flags=area,format=gray",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ]
    )
    if len(raw) != FRAME_BYTES:
        raise RuntimeError(f"invalid decoded screenshot frame for {path}")
    return raw


def _frame_error(left: bytes, right: bytes) -> float:
    return sum(abs(a - b) for a, b in zip(left, right, strict=True)) / FRAME_BYTES


def _best_match(label: str, screenshot: Path, videos: list[VideoFrames]) -> Match:
    target = _decode_screenshot(screenshot)
    best_video: VideoFrames | None = None
    best_index = -1
    best_error = float("inf")
    for video in videos:
        for index, frame in enumerate(video.frames):
            error = _frame_error(target, frame)
            if error < best_error:
                best_video = video
                best_index = index
                best_error = error
    if best_video is None or best_index < 0:
        raise RuntimeError(f"no frames available while locating {label}")
    return Match(
        label=label,
        screenshot=screenshot,
        video=best_video.path,
        seconds=best_index / best_video.fps,
        mean_absolute_error=best_error,
    )


def _screenshot_for(directory: Path, suffix: str) -> Path:
    matches = sorted(directory.glob(f"*-{suffix}.png"))
    if len(matches) != 1:
        raise RuntimeError(
            f"expected exactly one '*-{suffix}.png' beside the timeline; found {len(matches)}"
        )
    return matches[0]


def _seed_video(
    name: str,
    labels: set[str],
    matches: dict[str, Match],
) -> Path:
    paths = [matches[label].video for label in labels if label in matches]
    if len(paths) < 2:
        raise RuntimeError(f"{name} page needs at least two seed screenshots")
    counts = Counter(paths)
    best_count = max(counts.values())
    winners = [path for path, count in counts.items() if count == best_count]
    if len(winners) != 1 or best_count < 2:
        details = ", ".join(f"{path.name}={count}" for path, count in counts.items())
        raise RuntimeError(f"{name} seed screenshots did not identify one page video: {details}")
    return winners[0]


def _page_controls(
    name: str,
    labels: set[str],
    matches: dict[str, Match],
    timeline: dict[str, float],
) -> tuple[Path, tuple[tuple[float, float, str], ...]]:
    anchors = [matches[label] for label in labels if label in matches]
    if len(anchors) < 2:
        raise RuntimeError(f"{name} page needs at least two safe screenshot anchors")
    video_paths = {anchor.video for anchor in anchors}
    if len(video_paths) != 1:
        details = ", ".join(f"{anchor.label}={anchor.video.name}" for anchor in anchors)
        raise RuntimeError(f"{name} screenshot anchors resolved to multiple videos: {details}")
    controls = tuple(
        sorted(
            ((timeline[anchor.label], anchor.seconds, anchor.label) for anchor in anchors),
            key=lambda item: item[0],
        )
    )
    for left, right in pairwise(controls):
        global_delta = right[0] - left[0]
        video_delta = right[1] - left[1]
        if global_delta <= 0 or video_delta <= 0:
            raise RuntimeError(f"{name} page anchors are not monotonically ordered")
        scale = video_delta / global_delta
        if not 0.02 <= scale <= 5.00:
            raise RuntimeError(
                f"{name} page segment {left[2]!r} → {right[2]!r} has unsafe scale {scale:.4f}"
            )
    return next(iter(video_paths)), controls


def _map_time(
    global_seconds: float,
    controls: tuple[tuple[float, float, str], ...],
) -> float:
    if len(controls) < 2:
        raise RuntimeError("at least two page controls are required")
    if global_seconds <= controls[0][0]:
        left, right = controls[0], controls[1]
    elif global_seconds >= controls[-1][0]:
        left, right = controls[-2], controls[-1]
    else:
        left, right = next(
            (left, right)
            for left, right in pairwise(controls)
            if left[0] <= global_seconds <= right[0]
        )
    scale = (right[1] - left[1]) / (right[0] - left[0])
    return left[1] + (global_seconds - left[0]) * scale


def _challenge_text_detected(text: str) -> bool:
    normalized = " ".join(text.lower().split())
    return (
        "secure" in normalized
        and "authentication" in normalized
        and (
            "transaction with stripe" in normalized
            or "verify their identity" in normalized
            or "in live mode" in normalized
        )
    )


def _locate_private_challenge(
    video: VideoFrames,
    estimated_seconds: float,
    *,
    window_seconds: float = 8.0,
    step_seconds: float = 0.5,
) -> float:
    candidates: list[float] = []
    start = max(0.0, estimated_seconds - window_seconds)
    stop = min(video.duration, estimated_seconds + window_seconds)
    with tempfile.TemporaryDirectory(prefix="stripe-promo-challenge-") as directory:
        frame_path = Path(directory) / "frame.png"
        steps = int((stop - start) / step_seconds) + 1
        for index in range(steps):
            seconds = min(stop, start + index * step_seconds)
            _run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{seconds:.3f}",
                    "-i",
                    str(video.path),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=960:-2:flags=area",
                    "-y",
                    str(frame_path),
                ]
            )
            text = _run(["tesseract", str(frame_path), "stdout", "--psm", "6"]).decode(
                "utf-8", errors="replace"
            )
            if _challenge_text_detected(text):
                candidates.append(seconds)
    if not candidates:
        raise RuntimeError(
            f"could not locate a Stripe test 3DS challenge near {estimated_seconds:.3f}s"
        )

    groups: list[list[float]] = []
    for seconds in candidates:
        if not groups or seconds - groups[-1][-1] > step_seconds * 1.5:
            groups.append([seconds])
        else:
            groups[-1].append(seconds)
    selected = min(
        groups,
        key=lambda group: abs(((group[0] + group[-1]) / 2) - estimated_seconds),
    )
    return (selected[0] + selected[-1]) / 2


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeline", type=Path, required=True)
    parser.add_argument("--video", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fps", type=int, default=10)
    parser.add_argument(
        "--max-anchor-error",
        type=float,
        default=28.0,
        help="Maximum mean absolute grayscale error for a screenshot match.",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    for command in ("ffmpeg", "ffprobe", "tesseract"):
        if shutil.which(command) is None:
            raise SystemExit(f"missing required command: {command}")
    if args.fps < 2 or args.fps > 30:
        raise SystemExit("--fps must be between 2 and 30")
    if len(args.video) < 2:
        raise SystemExit("at least two --video values are required")

    timeline_payload: dict[str, Any] = json.loads(args.timeline.read_text())
    timeline_entries = timeline_payload.get("timeline")
    if not isinstance(timeline_entries, list):
        raise SystemExit("timeline JSON has no timeline list")
    timeline = {
        str(entry["label"]): float(entry["milliseconds"]) / 1000
        for entry in timeline_entries
        if isinstance(entry, dict) and "label" in entry and "milliseconds" in entry
    }

    video_frames = [_decode_video(path.resolve(), args.fps) for path in args.video]
    video_by_path = {video.path: video for video in video_frames}
    screenshot_dir = args.timeline.resolve().parent

    seed_labels = PRIMARY_SEED_LABELS | SECONDARY_SEED_LABELS
    seed_matches: dict[str, Match] = {}
    for label in seed_labels:
        if label not in timeline:
            continue
        suffix = SAFE_ANCHORS[label]
        seed_matches[label] = _best_match(
            label,
            _screenshot_for(screenshot_dir, suffix),
            video_frames,
        )
    primary_video = _seed_video("primary", PRIMARY_SEED_LABELS, seed_matches)
    secondary_video = _seed_video("secondary", SECONDARY_SEED_LABELS, seed_matches)
    if primary_video == secondary_video:
        raise SystemExit("primary and secondary seed screenshots resolved to the same video")

    matches: dict[str, Match] = {}
    for label, suffix in SAFE_ANCHORS.items():
        if label not in timeline:
            continue
        if label in PRIMARY_LABELS:
            candidate_videos = [video_by_path[primary_video]]
        elif label in SECONDARY_LABELS:
            candidate_videos = [video_by_path[secondary_video]]
        else:
            continue
        match = _best_match(
            label,
            _screenshot_for(screenshot_dir, suffix),
            candidate_videos,
        )
        if match.mean_absolute_error > args.max_anchor_error:
            raise SystemExit(
                f"screenshot match for {label!r} is too weak: "
                f"{match.mean_absolute_error:.2f} > {args.max_anchor_error:.2f}"
            )
        matches[label] = match

    primary_video, primary_controls = _page_controls("primary", PRIMARY_LABELS, matches, timeline)
    secondary_video, secondary_controls = _page_controls(
        "secondary", SECONDARY_LABELS, matches, timeline
    )

    events: dict[str, dict[str, Any]] = {}
    for label, global_seconds in timeline.items():
        if label in PRIMARY_LABELS:
            page_name = "primary"
            video_path = primary_video
            derived_seconds = _map_time(global_seconds, primary_controls)
        elif label in SECONDARY_LABELS:
            page_name = "secondary"
            video_path = secondary_video
            derived_seconds = _map_time(global_seconds, secondary_controls)
        else:
            continue
        if label in matches:
            derived_seconds = matches[label].seconds
        video = video_by_path[video_path]
        if not 0 <= derived_seconds <= video.duration:
            raise SystemExit(
                f"derived timestamp for {label!r} is outside {video.path.name}: "
                f"{derived_seconds:.3f}s / {video.duration:.3f}s"
            )
        events[label] = {
            "page": page_name,
            "video": str(video_path),
            "seconds": round(derived_seconds, 3),
        }

    for challenge_label in ("Checkout 3DS challenge", "Upgrade 3DS challenge"):
        event = events.get(challenge_label)
        if event is None:
            raise SystemExit(f"timeline is missing {challenge_label!r}")
        video_path = Path(str(event["video"]))
        video = video_by_path[video_path]
        event["timeline_estimate_seconds"] = event["seconds"]
        event["seconds"] = round(
            _locate_private_challenge(video, float(event["seconds"])),
            3,
        )
        event["locator"] = "private_ocr_without_persisted_frame"

    output = {
        "transition_policy": timeline_payload.get("transition_policy"),
        "fps": args.fps,
        "pages": {
            "primary": {
                "video": str(primary_video),
                "controls": [
                    {
                        "timeline_seconds": round(global_seconds, 3),
                        "video_seconds": round(video_seconds, 3),
                        "label": label,
                    }
                    for global_seconds, video_seconds, label in primary_controls
                ],
            },
            "secondary": {
                "video": str(secondary_video),
                "controls": [
                    {
                        "timeline_seconds": round(global_seconds, 3),
                        "video_seconds": round(video_seconds, 3),
                        "label": label,
                    }
                    for global_seconds, video_seconds, label in secondary_controls
                ],
            },
        },
        "anchors": {
            label: {
                "screenshot": str(match.screenshot),
                "video": str(match.video),
                "seconds": round(match.seconds, 3),
                "mean_absolute_error": round(match.mean_absolute_error, 3),
            }
            for label, match in sorted(matches.items())
        },
        "events": events,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(f"{json.dumps(output, indent=2, sort_keys=True)}\n")

    print(
        "located promo milestones: "
        f"primary={primary_video.name} anchors={len(primary_controls)}; "
        f"secondary={secondary_video.name} anchors={len(secondary_controls)}"
    )
    for label, match in sorted(matches.items()):
        print(
            f"anchor {label}: {match.video.name}@{match.seconds:.1f}s "
            f"error={match.mean_absolute_error:.2f}"
        )
    for label in ("Checkout 3DS challenge", "Upgrade 3DS challenge"):
        event = events[label]
        print(
            f"private challenge {label}: {Path(str(event['video'])).name}"
            f"@{float(event['seconds']):.1f}s"
        )


if __name__ == "__main__":
    main()
