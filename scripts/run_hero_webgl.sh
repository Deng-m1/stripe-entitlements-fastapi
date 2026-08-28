#!/usr/bin/env bash
# Proof gate for the WebGL hero (web/DESIGN_BRIEF.md §7.1).
#
# Builds the site, serves it with `next start`, and runs
# web/promo/hero-webgl.spec.ts against it. A production server is required
# rather than `next dev`: the fallback handover and the dynamic renderer chunk
# both behave differently under the dev overlay.
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

for command_name in node npm curl setsid ps python3; do
  command -v "$command_name" >/dev/null || {
    echo "missing required command: $command_name" >&2
    exit 2
  }
done

hero_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
hero_base_url="http://127.0.0.1:${hero_port}"
hero_output_dir="${HERO_OUTPUT_DIR:-$repo_root/web/test-results/hero-webgl}"
hero_tmp_dir="$(mktemp -d /tmp/stripe-entitlements-hero-webgl.XXXXXX)"
hero_pid=""
hero_pid_start=""
hero_pgid=""

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
  # Refuse to signal a recycled PID: the group we started must still be the
  # group we are about to kill.
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
}

cleanup() {
  local status="$1"
  trap - EXIT
  set +e
  if ! stop_process_group "$hero_pid" "$hero_pid_start" "$hero_pgid"; then
    status=1
  fi
  if [[ "$status" -eq 0 ]]; then
    rm -rf "$hero_tmp_dir"
  else
    echo "hero WebGL gate failed; server log kept in $hero_tmp_dir" >&2
  fi
  exit "$status"
}
trap 'cleanup $?' EXIT

rm -rf "$hero_output_dir"
mkdir -p "$hero_output_dir"

if [[ "${HERO_SKIP_BUILD:-0}" != "1" ]]; then
  NEXT_TELEMETRY_DISABLED=1 npm --prefix web run build
fi

(
  cd web
  exec setsid env -i \
    PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" \
    HOME="${HOME:-/tmp}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LANG="${LANG:-C.UTF-8}" \
    NEXT_TELEMETRY_DISABLED=1 \
    ./node_modules/.bin/next start --hostname 127.0.0.1 --port "$hero_port"
) >"$hero_tmp_dir/frontend.log" 2>&1 &
hero_pid="$!"
hero_pid_start="$(pid_start "$hero_pid")"
hero_pgid="$(ps -o pgid= -p "$hero_pid" | tr -d '[:space:]')"
if [[ "$hero_pgid" != "$hero_pid" ]]; then
  echo "hero Next.js process did not start in its own process group" >&2
  exit 1
fi

for _ in $(seq 1 90); do
  curl -fsS "$hero_base_url" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$hero_base_url" >/dev/null

env \
  HERO_BASE_URL="$hero_base_url" \
  HERO_OUTPUT_DIR="$hero_output_dir" \
  npm --prefix web run test:hero

echo "hero WebGL gate passed against $hero_base_url"
