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

uv run pytest \
  tests/real/test_stripe_test_mode.py::test_real_test_clock_annual_slots_downtime_and_renewal \
  -vv
