from __future__ import annotations

import argparse
import math
import wave
from array import array
from pathlib import Path

SAMPLE_RATE = 48_000
CHORD_SECONDS = 4.0
CHORDS = (
    (130.81, 164.81, 196.00, 246.94),  # Cmaj7
    (110.00, 130.81, 164.81, 196.00),  # Am7
    (87.31, 130.81, 164.81, 220.00),  # Fmaj7
    (98.00, 146.83, 196.00, 220.00),  # Gsus2
)


def smooth_edge(local_time: float, duration: float) -> float:
    attack = min(1.0, local_time / 0.55)
    release = min(1.0, max(0.0, duration - local_time) / 0.85)
    return attack * release


def sample_at(time_seconds: float) -> tuple[float, float]:
    chord_index = int(time_seconds // CHORD_SECONDS) % len(CHORDS)
    chord = CHORDS[chord_index]
    local = time_seconds % CHORD_SECONDS
    pad_envelope = smooth_edge(local, CHORD_SECONDS)

    pad_left = 0.0
    pad_right = 0.0
    for index, frequency in enumerate(chord):
        amplitude = 0.030 / (1.0 + index * 0.14)
        pad_left += amplitude * math.sin(2.0 * math.pi * frequency * time_seconds)
        pad_right += amplitude * math.sin(
            2.0 * math.pi * frequency * time_seconds + 0.11 * (index + 1)
        )
    pad_left *= pad_envelope
    pad_right *= pad_envelope

    beat_local = time_seconds % 1.0
    bass_envelope = math.exp(-4.2 * beat_local)
    root = chord[0] / 2.0
    bass = 0.055 * bass_envelope * math.sin(2.0 * math.pi * root * time_seconds)

    pluck_step = int(time_seconds / 0.5)
    pluck_frequency = chord[pluck_step % len(chord)] * 2.0
    pluck_local = time_seconds % 0.5
    pluck_envelope = math.exp(-8.5 * pluck_local)
    pluck = (
        0.025
        * pluck_envelope
        * (
            math.sin(2.0 * math.pi * pluck_frequency * time_seconds)
            + 0.35 * math.sin(4.0 * math.pi * pluck_frequency * time_seconds)
        )
    )

    pulse_local = time_seconds % 0.5
    pulse_envelope = math.exp(-22.0 * pulse_local)
    pulse = 0.009 * pulse_envelope * math.sin(2.0 * math.pi * 1_800.0 * time_seconds)

    return pad_left + bass + pluck + pulse, pad_right + bass + pluck - pulse


def write_music(output: Path, duration_seconds: float) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    total_samples = int(duration_seconds * SAMPLE_RATE)
    master_gain = 0.78
    block_size = 4_096

    with wave.open(str(output), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        for start in range(0, total_samples, block_size):
            frames = array("h")
            stop = min(total_samples, start + block_size)
            for sample_index in range(start, stop):
                time_seconds = sample_index / SAMPLE_RATE
                left, right = sample_at(time_seconds)
                frames.append(max(-32_767, min(32_767, int(left * master_gain * 32_767))))
                frames.append(max(-32_767, min(32_767, int(right * master_gain * 32_767))))
            wav.writeframes(frames.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate original low-key promo background music")
    parser.add_argument("output", type=Path)
    parser.add_argument("--duration", type=float, default=90.0)
    args = parser.parse_args()
    if not 1.0 <= args.duration <= 600.0:
        parser.error("--duration must be between 1 and 600 seconds")
    write_music(args.output, args.duration)


if __name__ == "__main__":
    main()
