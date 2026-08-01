#!/usr/bin/env bash
set -Eeuo pipefail

test_clock_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$test_clock_repo_root"

case "${STRIPE_SECRET_KEY:-}" in
  sk_test_*) ;;
  *)
    echo "Test Clock E2E requires STRIPE_SECRET_KEY=sk_test_..." >&2
    exit 2
    ;;
esac

for test_clock_command in docker uv; do
  command -v "$test_clock_command" >/dev/null || {
    echo "missing required command: $test_clock_command" >&2
    exit 2
  }
done
docker info >/dev/null 2>&1 || {
  echo "Docker must be running for the disposable PostgreSQL test database" >&2
  exit 2
}

test_clock_recovery_dir="$(mktemp -d /tmp/stripe-entitlements-test-clock.XXXXXX)"
chmod 700 "$test_clock_recovery_dir"
test_clock_recovery_manifest="$test_clock_recovery_dir/recovery.json"
test_clock_initial_manifest="$test_clock_recovery_dir/.recovery.initial.$$"
printf '%s\n' \
  '{"schema_version":1,"status":"runner_initialized","secret_free":true}' \
  >"$test_clock_initial_manifest"
chmod 600 "$test_clock_initial_manifest"
mv "$test_clock_initial_manifest" "$test_clock_recovery_manifest"

test_clock_cleanup() {
  local test_clock_status="$1"
  trap - EXIT
  if [[ "$test_clock_status" -eq 0 && -e "$test_clock_recovery_manifest" ]]; then
    echo "Test Clock E2E passed without removing its recovery manifest" >&2
    test_clock_status=1
  fi
  if [[ "$test_clock_status" -eq 0 ]]; then
    case "$test_clock_recovery_dir" in
      /tmp/stripe-entitlements-test-clock.*) rm -rf "$test_clock_recovery_dir" ;;
      *)
        echo "refusing to remove unexpected recovery directory" >&2
        test_clock_status=1
        ;;
    esac
  else
    echo "Test Clock E2E failed or was interrupted." >&2
    echo "Secret-free recovery state retained at: $test_clock_recovery_dir" >&2
  fi
  exit "$test_clock_status"
}
trap 'test_clock_cleanup $?' EXIT

TEST_CLOCK_RECOVERY_MANIFEST="$test_clock_recovery_manifest" uv run pytest \
  tests/real/test_stripe_test_mode.py::test_real_test_clock_annual_slots_downtime_and_renewal \
  -vv
