#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

for command_name in node npm curl setsid ps; do
  command -v "$command_name" >/dev/null || {
    echo "missing required command: $command_name" >&2
    exit 2
  }
done

promo_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
promo_base_url="http://127.0.0.1:${promo_port}"
promo_output_dir="${PROMO_OUTPUT_DIR:-$repo_root/web/test-results/promo-ui}"
promo_tmp_dir="$(mktemp -d /tmp/stripe-entitlements-promo-ui.XXXXXX)"
promo_pid=""
promo_pid_start=""
promo_pgid=""

pid_start() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/stat" ]] || return 1
  # starttime is field 22, but field 2 (comm) is parenthesised and may contain
  # spaces — Next.js renames itself to "next-server (v16..." once it boots, so
  # naive whitespace splitting reads a different column before and after that
  # rename. Cut past the final ") " instead; every field after comm is numeric,
  # so the greedy match can only land on comm's own closing parenthesis.
  local stat rest
  stat="$(< "/proc/$pid/stat")"
  rest="${stat##*') '}"
  awk '{print $20}' <<<"$rest"
}

stop_process_group() {
  local pid="${1:-}"
  local expected_start="${2:-}"
  local pgid="${3:-}"
  [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ ]] || return 0
  if kill -0 "$pid" 2>/dev/null && \
      [[ "$(pid_start "$pid" 2>/dev/null || true)" != "$expected_start" ]]; then
    echo "refusing to stop PID $pid after process identity changed" >&2
    return 1
  fi
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for _ in $(seq 1 80); do
    ! kill -0 -- "-$pgid" 2>/dev/null && break
    sleep 0.1
  done
  if kill -0 -- "-$pgid" 2>/dev/null; then
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true

  for _ in $(seq 1 50); do
    [[ ! -e "$repo_root/web/.next/dev/lock" ]] && return 0
    sleep 0.1
  done
  echo "Next.js recording process group stopped but .next/dev/lock remains" >&2
  return 1
}

cleanup() {
  local status="$1"
  trap - EXIT
  set +e
  if ! stop_process_group "$promo_pid" "$promo_pid_start" "$promo_pgid"; then
    status=1
  fi
  if [[ "$status" -eq 0 ]]; then
    rm -rf "$promo_tmp_dir"
  else
    echo "promo UI recording failed; logs kept in $promo_tmp_dir" >&2
  fi
  exit "$status"
}
trap 'cleanup $?' EXIT

rm -rf "$promo_output_dir"
mkdir -p "$promo_output_dir"

(
  cd web
  exec setsid env -i \
    PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" \
    HOME="${HOME:-/tmp}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LANG="${LANG:-C.UTF-8}" \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_BILLING_API_MODE=mock \
    ./node_modules/.bin/next dev --hostname 127.0.0.1 --port "$promo_port"
) >"$promo_tmp_dir/frontend.log" 2>&1 &
promo_pid="$!"
promo_pid_start="$(pid_start "$promo_pid")"
promo_pgid="$(ps -o pgid= -p "$promo_pid" | tr -d '[:space:]')"
if [[ "$promo_pgid" != "$promo_pid" ]]; then
  echo "promo Next.js process did not start in its own process group" >&2
  exit 1
fi

for _ in $(seq 1 90); do
  curl -fsS "$promo_base_url" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$promo_base_url" >/dev/null

env \
  PROMO_BASE_URL="$promo_base_url" \
  PROMO_OUTPUT_DIR="$promo_output_dir" \
  PROMO_STEP_PAUSE_MS="${PROMO_STEP_PAUSE_MS:-1600}" \
  npm --prefix web run test:promo

video_path="$(find "$promo_output_dir" -type f -name '*.webm' -print -quit)"
if [[ -z "$video_path" ]]; then
  echo "Playwright completed without producing a promo video" >&2
  exit 1
fi

echo "promo UI recording passed"
echo "raw video: $video_path"
