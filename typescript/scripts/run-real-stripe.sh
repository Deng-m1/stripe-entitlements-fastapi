#!/usr/bin/env bash
set -euo pipefail

stripe_test_key="${STRIPE_SECRET_KEY:-}"
if [[ ! "$stripe_test_key" =~ ^sk_test_[[:alnum:]]{16,}$ ]]; then
  echo "TypeScript real Stripe tests refuse live, restricted, missing, or malformed keys" >&2
  exit 2
fi

if [[ "${1:-}" == "--guard-only" ]]; then
  exit 0
fi

if [[ $# -ne 0 ]]; then
  echo "usage: scripts/run-real-stripe.sh [--guard-only]" >&2
  exit 2
fi

for stripe_test_command in docker npx; do
  command -v "$stripe_test_command" >/dev/null || {
    echo "missing required command: $stripe_test_command" >&2
    exit 2
  }
done
docker info >/dev/null 2>&1 || {
  echo "Docker must be running for the disposable PostgreSQL test database" >&2
  exit 2
}

stripe_test_recovery_dir="$(mktemp -d /tmp/stripe-entitlements-ts-real.XXXXXX)"
chmod 700 "$stripe_test_recovery_dir"
export STRIPE_TS_REAL_RECOVERY_DIR="$stripe_test_recovery_dir"

stripe_test_cleanup() {
  local stripe_test_status="$1"
  trap - EXIT
  if [[ "$stripe_test_status" -eq 0 ]]; then
    case "$stripe_test_recovery_dir" in
      /tmp/stripe-entitlements-ts-real.*)
        if ! rmdir "$stripe_test_recovery_dir"; then
          echo "TypeScript real Stripe suite passed with residual recovery state" >&2
          stripe_test_status=1
        fi
        ;;
      *)
        echo "refusing to remove an unexpected recovery directory" >&2
        stripe_test_status=1
        ;;
    esac
  else
    echo "TypeScript real Stripe suite failed or was interrupted." >&2
    echo "Secret-free recovery state retained at: $stripe_test_recovery_dir" >&2
  fi
  exit "$stripe_test_status"
}
trap 'stripe_test_cleanup $?' EXIT

npx vitest run --project real-stripe
