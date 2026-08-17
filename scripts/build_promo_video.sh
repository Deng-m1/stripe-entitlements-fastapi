#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

command -v ffmpeg >/dev/null || {
  echo "ffmpeg is required to build the promotional video" >&2
  exit 2
}
command -v ffprobe >/dev/null || {
  echo "ffprobe is required to verify the promotional video" >&2
  exit 2
}

promo_capture_dir="${PROMO_CAPTURE_DIR:-}"
if [[ -z "$promo_capture_dir" ]]; then
  promo_capture_dir="$(find web/test-results/promo-ui -type f -name '01-landing-hero.png' \
    -printf '%h\n' 2>/dev/null | sort | tail -1 || true)"
fi
real_capture_dir="${REAL_CAPTURE_DIR:-}"
if [[ -z "$real_capture_dir" ]]; then
  real_capture_dir="$(find web/test-results/playwright-stripe-prorated_delta \
    -type f -name 'video.webm' -printf '%h\n' 2>/dev/null | sort | tail -1 || true)"
fi

if [[ -z "$promo_capture_dir" || -z "$real_capture_dir" ]]; then
  echo "record the UI tour and prorated Stripe E2E before building the video" >&2
  exit 2
fi

hero="$promo_capture_dir/01-landing-hero.png"
catalog="$promo_capture_dir/03-reference-catalog.png"
annual="$promo_capture_dir/06-annual-savings.png"
full_preview="$promo_capture_dir/07-plan-change-preview.png"
account="$promo_capture_dir/09-account-projection.png"
timeline="$real_capture_dir/timeline.json"
mapfile -t real_videos < <(
  find "$real_capture_dir" -maxdepth 1 -type f -name 'video*.webm' -print | sort
)
if [[ "${#real_videos[@]}" -ne 2 ]]; then
  echo "expected exactly two Playwright page videos in $real_capture_dir" >&2
  exit 2
fi

for source in \
  "$hero" "$catalog" "$annual" "$full_preview" "$account" "$timeline" \
  "${real_videos[0]}" "${real_videos[1]}" \
  "$repo_root/scripts/generate_promo_music.py" \
  "$repo_root/scripts/locate_promo_frames.py"; do
  [[ -s "$source" ]] || {
    echo "missing promotional source: $source" >&2
    exit 2
  }
done

font_regular="${PROMO_FONT_REGULAR:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}"
font_bold="${PROMO_FONT_BOLD:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}"
[[ -s "$font_regular" && -s "$font_bold" ]] || {
  echo "DejaVu Sans fonts are required; set PROMO_FONT_REGULAR/PROMO_FONT_BOLD" >&2
  exit 2
}

output="${PROMO_OUTPUT:-$repo_root/web/test-results/promo-final/stripe-entitlements-fastapi-promo.mp4}"
poster="${PROMO_POSTER_OUTPUT:-${output%.mp4}-poster.png}"
music="${PROMO_MUSIC_OUTPUT:-${output%.mp4}-music.wav}"
milestones="${PROMO_MILESTONES_OUTPUT:-${output%.mp4}-milestones.json}"
scene_manifest="${PROMO_SCENE_MANIFEST_OUTPUT:-${output%.mp4}-scenes.json}"
scene_names=(
  title landing catalog annual-pricing full-period-policy account-truth free-state
  decline checkout-3ds starter-projection prorated-delta upgrade-3ds pro-projection
  redirect-boundary outro
)
scene_durations=(3.2 3.0 3.0 3.0 3.4 3.0 3.0 4.0 1.8 4.0 4.7 1.8 4.2 3.2 3.5)
promo_duration="$(python3 -c \
  'import sys; print(f"{sum(map(float,sys.argv[1:])):.3f}")' \
  "${scene_durations[@]}")"
promo_fade_out_start="$(python3 -c \
  'import sys; print(f"{float(sys.argv[1])-3:.3f}")' "$promo_duration")"
mkdir -p "$(dirname "$output")"

python3 scripts/locate_promo_frames.py \
  --timeline "$timeline" \
  --video "${real_videos[0]}" \
  --video "${real_videos[1]}" \
  --output "$milestones"
python3 scripts/generate_promo_music.py "$music" --duration 60

milestone_value() {
  local section="$1"
  local key="$2"
  local field="$3"
  python3 -c \
    'import json,sys; data=json.load(open(sys.argv[1])); print(data[sys.argv[2]][sys.argv[3]][sys.argv[4]])' \
    "$milestones" "$section" "$key" "$field"
}
clip_start() {
  python3 -c 'import sys; print(f"{max(0.0,float(sys.argv[1])-float(sys.argv[2])):.3f}")' \
    "$1" "$2"
}

primary_video="$(milestone_value pages primary video)"
account_video="$(milestone_value pages secondary video)"
free_start="$(clip_start "$(milestone_value events 'Free account · zero credits' seconds)" 0.8)"
decline_start="$(clip_start "$(milestone_value events 'Declined payment · access unchanged' seconds)" 1.6)"
checkout_3ds_start="$(clip_start "$(milestone_value events 'Checkout 3DS challenge' seconds)" 0.6)"
checkout_success_start="$(clip_start "$(milestone_value events 'Webhook-backed Checkout success' seconds)" 0.5)"
preview_start="$(clip_start "$(milestone_value events 'Prorated delta · +700 entitlement credits' seconds)" 0.5)"
upgrade_3ds_start="$(clip_start "$(milestone_value events 'Upgrade 3DS challenge' seconds)" 0.6)"
upgrade_success_start="$(clip_start "$(milestone_value events 'Webhook-backed upgrade success' seconds)" 0.5)"
pro_start="$(clip_start "$(milestone_value events 'Pro Monthly · 1,000 credits' seconds)" 0.5)"

badge_ui="drawbox=x=52:y=48:w=560:h=58:color=0x142033@0.88:t=fill,drawtext=fontfile=${font_bold}:text='OPEN-SOURCE UI REFERENCE':fontcolor=white:fontsize=26:x=76:y=65"
badge_test="drawbox=x=52:y=48:w=690:h=58:color=0x142033@0.90:t=fill,drawtext=fontfile=${font_bold}:text='STRIPE TEST MODE - NO REAL CHARGE':fontcolor=white:fontsize=24:x=76:y=66"
caption_box="drawbox=x=0:y=ih-154:w=iw:h=154:color=0x0F172A@0.78:t=fill"
ken_burns="zoompan=z='min(1+0.0005*on,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30"

ffmpeg -hide_banner -y \
  -f lavfi -t "${scene_durations[0]}" -i "color=c=0x142033:s=1920x1080:r=30" \
  -loop 1 -t "${scene_durations[1]}" -framerate 30 -i "$hero" \
  -loop 1 -t "${scene_durations[2]}" -framerate 30 -i "$catalog" \
  -loop 1 -t "${scene_durations[3]}" -framerate 30 -i "$annual" \
  -loop 1 -t "${scene_durations[4]}" -framerate 30 -i "$full_preview" \
  -loop 1 -t "${scene_durations[5]}" -framerate 30 -i "$account" \
  -ss "$free_start" -t "${scene_durations[6]}" -i "$account_video" \
  -ss "$decline_start" -t "${scene_durations[7]}" -i "$primary_video" \
  -ss "$checkout_3ds_start" -t "${scene_durations[8]}" -i "$primary_video" \
  -ss "$checkout_success_start" -t "${scene_durations[9]}" -i "$primary_video" \
  -ss "$preview_start" -t "${scene_durations[10]}" -i "$account_video" \
  -ss "$upgrade_3ds_start" -t "${scene_durations[11]}" -i "$account_video" \
  -ss "$upgrade_success_start" -t "${scene_durations[12]}" -i "$account_video" \
  -ss "$pro_start" -t "${scene_durations[13]}" -i "$primary_video" \
  -f lavfi -t "${scene_durations[14]}" -i "color=c=0x142033:s=1920x1080:r=30" \
  -i "$music" \
  -filter_complex "
    [0:v]drawbox=x=190:y=210:w=1540:h=660:color=0x2055D6@0.16:t=fill,
      drawtext=fontfile=${font_bold}:text='Stripe Entitlements for FastAPI':fontcolor=white:fontsize=78:x=(w-text_w)/2:y=346,
      drawtext=fontfile=${font_regular}:text='Race-safe subscriptions - credits - refunds - upgrades':fontcolor=0xE7EEFF:fontsize=40:x=(w-text_w)/2:y=466,
      drawtext=fontfile=${font_bold}:text='FastAPI  PostgreSQL  Next.js  Stripe':fontcolor=0x9FC0FF:fontsize=34:x=(w-text_w)/2:y=550,
      drawtext=fontfile=${font_bold}:text='OPEN SOURCE  APACHE-2.0':fontcolor=white:fontsize=26:x=(w-text_w)/2:y=690,
      format=yuv420p,setpts=PTS-STARTPTS[v0];

    [1:v]scale=1920:1080,${ken_burns},setsar=1,${badge_ui},${caption_box},
      drawtext=fontfile=${font_bold}:text='A production-minded Stripe billing reference':fontcolor=white:fontsize=46:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v1];
    [2:v]scale=1920:1080,${ken_burns},setsar=1,${badge_ui},${caption_box},
      drawtext=fontfile=${font_bold}:text='Explicit plans - annual grants - structured entitlements':fontcolor=white:fontsize=43:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v2];
    [3:v]scale=1920:1080,${ken_burns},setsar=1,${badge_ui},${caption_box},
      drawtext=fontfile=${font_bold}:text='Monthly and yearly pricing without hiding the tradeoffs':fontcolor=white:fontsize=42:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v3];
    [4:v]scale=1920:1080,${ken_burns},setsar=1,${badge_ui},${caption_box},
      drawtext=fontfile=${font_bold}:text='full_period_reset - a newly funded target period':fontcolor=white:fontsize=44:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v4];
    [5:v]scale=1920:1080,${ken_burns},setsar=1,${badge_ui},${caption_box},
      drawtext=fontfile=${font_bold}:text='PostgreSQL is the entitlement and credit truth':fontcolor=white:fontsize=46:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v5];

    [6:v]tpad=stop_mode=clone:stop_duration=${scene_durations[6]},trim=duration=${scene_durations[6]},
      scale=1920:1080,${badge_test},${caption_box},
      drawtext=fontfile=${font_bold}:text='Start from Free - zero credits - no enforceable access':fontcolor=white:fontsize=42:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v6];
    [7:v]tpad=stop_mode=clone:stop_duration=${scene_durations[7]},trim=duration=${scene_durations[7]},
      crop=700:394:730:300,scale=1920:1080,setsar=1,
      drawbox=x=180:y=235:w=1020:h=220:color=white@1:t=fill,
      drawbox=x=180:y=620:w=1150:h=190:color=white@1:t=fill,
      ${badge_test},${caption_box},
      drawtext=fontfile=${font_bold}:text='Declined payment never grants entitlement':fontcolor=white:fontsize=50:x=80:y=h-110,
      format=yuv420p,setpts=PTS-STARTPTS[v7];
    [8:v]tpad=stop_mode=clone:stop_duration=${scene_durations[8]},trim=duration=${scene_durations[8]},
      scale=1920:1080,${badge_test},${caption_box},
      drawtext=fontfile=${font_bold}:text='Real Stripe test-mode 3D Secure authentication':fontcolor=white:fontsize=46:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v8];
    [9:v]tpad=stop_mode=clone:stop_duration=${scene_durations[9]},trim=duration=${scene_durations[9]},
      scale=1920:1080,${badge_test},${caption_box},
      drawtext=fontfile=${font_bold}:text='Signed webhook - Starter Monthly - 300 credits':fontcolor=white:fontsize=46:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v9];
    [10:v]tpad=stop_mode=clone:stop_duration=${scene_durations[10]},trim=duration=${scene_durations[10]},
      scale=1920:1080,${badge_test},${caption_box},
      drawtext=fontfile=${font_bold}:text='prorated_delta - prorated cash - fixed +700 entitlement credits':fontcolor=white:fontsize=40:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v10];
    [11:v]tpad=stop_mode=clone:stop_duration=${scene_durations[11]},trim=duration=${scene_durations[11]},
      scale=1920:1080,${badge_test},${caption_box},
      drawtext=fontfile=${font_bold}:text='SCA recovery keeps the old paid entitlement active':fontcolor=white:fontsize=44:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v11];
    [12:v]tpad=stop_mode=clone:stop_duration=${scene_durations[12]},trim=duration=${scene_durations[12]},
      scale=1920:1080,${badge_test},${caption_box},
      drawtext=fontfile=${font_bold}:text='Paid webhook - Pro Monthly - 1,000 credits':fontcolor=white:fontsize=48:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v12];
    [13:v]tpad=stop_mode=clone:stop_duration=${scene_durations[13]},trim=duration=${scene_durations[13]},
      scale=1920:1080,${badge_test},${caption_box},
      drawtext=fontfile=${font_bold}:text='Browser redirects never become authorization':fontcolor=white:fontsize=48:x=80:y=h-108,
      format=yuv420p,setpts=PTS-STARTPTS[v13];

    [14:v]drawbox=x=190:y=210:w=1540:h=660:color=0x2055D6@0.16:t=fill,
      drawtext=fontfile=${font_bold}:text='FromCSUZhou/stripe-entitlements-fastapi':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=374,
      drawtext=fontfile=${font_regular}:text='Two complete billing policies - race-safe webhook projection':fontcolor=0xE7EEFF:fontsize=38:x=(w-text_w)/2:y=486,
      drawtext=fontfile=${font_bold}:text='Independent community project - Stripe test mode shown':fontcolor=0x9FC0FF:fontsize=29:x=(w-text_w)/2:y=610,
      format=yuv420p,setpts=PTS-STARTPTS[v14];

    [v0][v1][v2][v3][v4][v5][v6][v7][v8][v9][v10][v11][v12][v13][v14]
      concat=n=15:v=1:a=0[outv];
    [15:a]atrim=duration=${promo_duration},asetpts=PTS-STARTPTS,volume=3.15,
      afade=t=in:st=0:d=1.5,afade=t=out:st=${promo_fade_out_start}:d=3[outa]
  " \
  -map "[outv]" -map "[outa]" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 30 \
  -c:a aac -b:a 96k -shortest -movflags +faststart \
  -metadata title="Stripe Entitlements for FastAPI" \
  -metadata comment="Stripe test-mode promotional walkthrough; no real charge" \
  "$output"

python3 - "$scene_manifest" "${scene_names[*]}" "${scene_durations[*]}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
names = sys.argv[2].split()
durations = [float(value) for value in sys.argv[3].split()]
if len(names) != len(durations):
    raise SystemExit("scene name/duration count mismatch")
position = 0.0
scenes = []
for name, duration in zip(names, durations, strict=True):
    scenes.append(
        {
            "name": name,
            "seconds": round(position + duration / 2, 3),
            "duration": duration,
        }
    )
    position += duration
payload = {"duration": round(position, 3), "scenes": scenes}
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(f"{json.dumps(payload, indent=2)}\n", encoding="utf-8")
PY

actual_duration="$(ffprobe -v error -show_entries format=duration \
  -of default=nw=1:nk=1 "$output")"
python3 -c \
  'import sys; expected=float(sys.argv[1]); actual=float(sys.argv[2]);
if abs(expected-actual)>0.05: raise SystemExit(f"promo duration drift: {actual:.3f}s != {expected:.3f}s")' \
  "$promo_duration" "$actual_duration"

ffmpeg -hide_banner -loglevel error -y -ss 5.2 -i "$output" -frames:v 1 "$poster"
ffmpeg -hide_banner -v error -i "$output" -f null -

printf 'promotional video: %s\n' "$output"
printf 'poster image: %s\n' "$poster"
printf 'scene manifest: %s\n' "$scene_manifest"
ffprobe -v error -show_entries format=duration,size \
  -show_entries stream=codec_name,width,height,r_frame_rate,pix_fmt \
  -of default=noprint_wrappers=1 "$output"
