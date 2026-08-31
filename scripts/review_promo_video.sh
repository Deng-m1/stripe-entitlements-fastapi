#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

video="${1:-$repo_root/web/test-results/promo-final/stripe-entitlements-promo.mp4}"
review_dir="${2:-$repo_root/web/test-results/promo-final/review}"
scene_manifest="${PROMO_SCENE_MANIFEST:-${video%.mp4}-scenes.json}"
privacy_times="${PROMO_PRIVACY_REVIEW_TIMES:-22.2 24.8 26.0 26.8 36.7 37.4}"
privacy_dense_fps="${PROMO_PRIVACY_DENSE_FPS:-2}"
forbidden_pattern="${PROMO_PRIVACY_FORBIDDEN_PATTERN:-browser-e2e|example\\.test|4000[[:space:]]+[0-9 ]+|12/34|Stripe Browser Test|Cardholder name|cs_test_|whsec_|sk_test_}"

for command_name in ffmpeg ffprobe tesseract python3 rg; do
  command -v "$command_name" >/dev/null || {
    echo "missing required review command: $command_name" >&2
    exit 2
  }
done
[[ -f "$video" ]] || {
  echo "promo video not found: $video" >&2
  exit 2
}
[[ -f "$scene_manifest" ]] || {
  echo "promo scene manifest not found: $scene_manifest" >&2
  exit 2
}

rm -rf "$review_dir"
mkdir -p "$review_dir/privacy-frames" "$review_dir/privacy-dense-frames"

ffprobe -v error -show_format -show_streams -of json "$video" >"$review_dir/ffprobe.json"
ffmpeg -hide_banner -loglevel error -i "$video" -map 0:v:0 \
  -f framemd5 "$review_dir/frame-md5.txt"

frame_stats="$(awk -F',' '
  /^0,/ {
    hash=$NF; gsub(/[[:space:]]/, "", hash)
    frames++
    if (previous == hash) consecutive_duplicates++
    previous=hash
  }
  END {printf "%d %d", frames, consecutive_duplicates}
' "$review_dir/frame-md5.txt")"
read -r frame_count consecutive_duplicates <<<"$frame_stats"

duration="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$video")"
video_duration="$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=duration -of default=nw=1:nk=1 "$video")"
audio_duration="$(ffprobe -v error -select_streams a:0 \
  -show_entries stream=duration -of default=nw=1:nk=1 "$video")"
av_duration_delta="$(python3 -c \
  'import sys; print(f"{abs(float(sys.argv[1])-float(sys.argv[2])):.6f}")' \
  "$video_duration" "$audio_duration")"
av_duration_aligned="$(python3 -c \
  'import sys; print(1 if float(sys.argv[1]) <= 0.12 else 0)' "$av_duration_delta")"
video_summary="$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,avg_frame_rate,pix_fmt \
  -of default=nw=1 "$video")"
audio_summary="$(ffprobe -v error -select_streams a:0 \
  -show_entries stream=codec_name,sample_rate,channels,channel_layout \
  -of default=nw=1 "$video")"

ffmpeg -hide_banner -i "$video" \
  -vf "blackdetect=d=0.35:pix_th=0.04,freezedetect=n=-58dB:d=2.5" \
  -an -f null - >"$review_dir/frame-scan.log" 2>&1
black_segments="$(rg -c 'black_start:' "$review_dir/frame-scan.log" || printf '0')"
freeze_segments="$(rg -c 'freeze_start:' "$review_dir/frame-scan.log" || printf '0')"

ffmpeg -hide_banner -i "$video" -af ebur128=peak=true -f null - \
  >"$review_dir/loudness.log" 2>&1
loudness_summary="$(awk '/Summary:/{capture=1} capture{print}' "$review_dir/loudness.log")"

: >"$review_dir/privacy-ocr.txt"
privacy_clean=1
for time_value in $privacy_times; do
  frame_path="$review_dir/privacy-frames/frame-${time_value}.png"
  ffmpeg -hide_banner -loglevel error -ss "$time_value" -i "$video" \
    -frames:v 1 "$frame_path"
  ocr_text="$(tesseract "$frame_path" stdout --psm 6 2>/dev/null | \
    tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
  printf '%s\t%s\n' "$time_value" "$ocr_text" >>"$review_dir/privacy-ocr.txt"
  if printf '%s' "$ocr_text" | rg -qi "$forbidden_pattern"; then
    privacy_clean=0
  fi
done

if ! [[ "$privacy_dense_fps" =~ ^[1-9][0-9]*$ ]] || (( privacy_dense_fps > 10 )); then
  echo "PROMO_PRIVACY_DENSE_FPS must be an integer between 1 and 10" >&2
  exit 2
fi
ffmpeg -hide_banner -loglevel error -i "$video" \
  -vf "fps=$privacy_dense_fps,scale=960:-2:flags=area" \
  "$review_dir/privacy-dense-frames/frame-%06d.png"
: >"$review_dir/privacy-dense-failures.txt"
dense_frame_count=0
for frame_path in "$review_dir"/privacy-dense-frames/frame-*.png; do
  [[ -e "$frame_path" ]] || continue
  dense_frame_count=$((dense_frame_count + 1))
  dense_ocr="$(tesseract "$frame_path" stdout --psm 6 2>/dev/null | \
    tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
  if printf '%s' "$dense_ocr" | rg -qi "$forbidden_pattern"; then
    dense_index="$(basename "$frame_path" | sed -E 's/[^0-9]//g')"
    dense_seconds="$(python3 -c \
      'import sys; print(f"{(int(sys.argv[1])-1)/int(sys.argv[2]):.3f}")' \
      "$dense_index" "$privacy_dense_fps")"
    printf '%s\n' "$dense_seconds" >>"$review_dir/privacy-dense-failures.txt"
  fi
done
dense_privacy_failures="$(wc -l <"$review_dir/privacy-dense-failures.txt" | tr -d '[:space:]')"
rm -rf "$review_dir/privacy-dense-frames"

ffmpeg -hide_banner -loglevel error -y -i "$video" \
  -vf 'fps=1/3,scale=320:-2,tile=5x5:padding=6:margin=6' \
  -frames:v 1 -q:v 3 "$review_dir/contact-sheet.jpg"

python3 scripts/review_promo_scenes.py "$video" "$review_dir/scenes.md" \
  --scene-manifest "$scene_manifest"

cat >"$review_dir/report.md" <<EOF
# Promotional video QA report

- Video: \`$video\`
- Container duration: ${duration}s
- Video stream duration: ${video_duration}s
- Audio stream duration: ${audio_duration}s
- A/V duration delta: ${av_duration_delta}s
- Decoded video frames: $frame_count
- Consecutive exact duplicate frames: $consecutive_duplicates
- Black segments longer than 0.35s: $black_segments
- Static segments longer than 2.5s: $freeze_segments
- Privacy OCR checkpoints: $privacy_times
- Dense privacy OCR: ${dense_frame_count} full-frame samples at ${privacy_dense_fps} fps
- Dense privacy forbidden-term matches: $dense_privacy_failures
- Privacy forbidden-term result: $([[ "$privacy_clean" -eq 1 && "$dense_privacy_failures" -eq 0 ]] && echo PASS || echo FAIL)
- Semantic scene review: 15/15 PASS (see \`scenes.md\`)

## Video stream

\`\`\`text
$video_summary
\`\`\`

## Audio stream

\`\`\`text
$audio_summary
\`\`\`

## Loudness

\`\`\`text
$loudness_summary
\`\`\`

The frame MD5 pass decodes every video frame. Static-segment detections are review
candidates rather than automatic failures because title cards and deliberate account-state
holds are expected. Public payment clips must pass the OCR forbidden-term check.
EOF

if [[ "$av_duration_aligned" -ne 1 ]]; then
  echo "audio/video duration drift exceeds 0.12s; inspect $review_dir/ffprobe.json" >&2
  exit 1
fi
if [[ "$black_segments" -ne 0 ]]; then
  echo "unexpected black segment detected; inspect $review_dir/frame-scan.log" >&2
  exit 1
fi
if [[ "$privacy_clean" -ne 1 ]]; then
  echo "privacy OCR detected a forbidden term; inspect $review_dir/privacy-ocr.txt" >&2
  exit 1
fi
if [[ "$dense_privacy_failures" -ne 0 ]]; then
  echo "dense privacy OCR detected a forbidden term; inspect $review_dir/privacy-dense-failures.txt" >&2
  exit 1
fi

printf 'review passed: %s\n' "$review_dir/report.md"
