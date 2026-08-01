#!/usr/bin/env bash
set -Eeuo pipefail

e2e_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$e2e_repo_root"

case "${STRIPE_SECRET_KEY:-}" in
  sk_test_*) ;;
  *) echo "browser E2E requires STRIPE_SECRET_KEY=sk_test_..." >&2; exit 2 ;;
esac
case "${STRIPE_PUBLISHABLE_KEY:-}" in
  pk_test_*) ;;
  *) echo "browser E2E requires STRIPE_PUBLISHABLE_KEY=pk_test_..." >&2; exit 2 ;;
esac

e2e_request_version="${STRIPE_API_VERSION:-2026-06-24.dahlia}"
e2e_event_version="${E2E_STRIPE_EVENT_API_VERSION:-2026-06-24.dahlia}"
e2e_transition_policy="${E2E_TRANSITION_POLICY:-full_period_reset}"
case "$e2e_transition_policy" in
  full_period_reset|prorated_delta) ;;
  *) echo "E2E_TRANSITION_POLICY must be full_period_reset or prorated_delta" >&2; exit 2 ;;
esac
e2e_upgrade_payment_method="${E2E_UPGRADE_PAYMENT_METHOD:-pm_card_authenticationRequired}"
case "$e2e_upgrade_payment_method" in
  pm_card_authenticationRequired|pm_card_visa) ;;
  *) echo "E2E_UPGRADE_PAYMENT_METHOD is not an allowlisted Stripe test fixture" >&2; exit 2 ;;
esac
e2e_cloudflared="${CLOUDFLARED_BIN:-cloudflared}"
e2e_postgres_image="${E2E_POSTGRES_IMAGE:-postgres:17-alpine}"
if [[ -z "$e2e_postgres_image" ]]; then
  echo "E2E_POSTGRES_IMAGE must not be empty" >&2
  exit 2
fi
e2e_run_id="$(date -u +%Y%m%d%H%M%S)-$$"
e2e_external_ref="browser-e2e-$e2e_run_id"
e2e_description="stripe-entitlements-browser-e2e-$e2e_run_id"
e2e_pg_container="stripe-entitlements-browser-e2e-pg-$$"
e2e_tmp_dir="$(mktemp -d /tmp/stripe-entitlements-browser-e2e.XXXXXX)"
e2e_endpoint_state="$e2e_tmp_dir/webhook.json"
e2e_cleanup_manifest="$e2e_tmp_dir/cleanup-manifest.json"
e2e_endpoint_id=""
e2e_webhook_url=""
e2e_webhook_create_started=0
e2e_tunnel_pid=""
e2e_backend_pid=""
e2e_frontend_pid=""
e2e_tunnel_start=""
e2e_backend_start=""
e2e_frontend_start=""
e2e_child_path="${PATH:-/usr/local/bin:/usr/bin:/bin}"
e2e_child_home="${HOME:-/tmp}"
e2e_child_tmp="${TMPDIR:-/tmp}"
e2e_child_lang="${LANG:-C.UTF-8}"

e2e_free_port() {
  uv run python -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

e2e_pg_port="$(e2e_free_port)"
e2e_backend_port="$(e2e_free_port)"
while [[ "$e2e_backend_port" == "$e2e_pg_port" ]]; do
  e2e_backend_port="$(e2e_free_port)"
done
e2e_frontend_port="$(e2e_free_port)"
while [[ "$e2e_frontend_port" == "$e2e_pg_port" || \
         "$e2e_frontend_port" == "$e2e_backend_port" ]]; do
  e2e_frontend_port="$(e2e_free_port)"
done
e2e_database_url="postgresql://postgres:local-only@127.0.0.1:${e2e_pg_port}/stripe_entitlements"
e2e_backend_url="http://127.0.0.1:${e2e_backend_port}"
e2e_frontend_url="http://127.0.0.1:${e2e_frontend_port}"
e2e_demo_token="$(uv run python -c 'import secrets; print(secrets.token_urlsafe(32))')"

e2e_pid_start() {
  local e2e_pid="${1:-}"
  [[ "$e2e_pid" =~ ^[0-9]+$ && -r "/proc/$e2e_pid/stat" ]] || return 1
  awk '{print $22}' "/proc/$e2e_pid/stat"
}

e2e_stop_pid() {
  local e2e_pid="${1:-}"
  local e2e_expected_start="${2:-}"
  [[ "$e2e_pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$e2e_pid" 2>/dev/null || return 0
  local e2e_observed_start
  e2e_observed_start="$(e2e_pid_start "$e2e_pid" 2>/dev/null || true)"
  if [[ -z "$e2e_expected_start" || "$e2e_observed_start" != "$e2e_expected_start" ]]; then
    echo "refusing to stop PID $e2e_pid after process identity changed" >&2
    return 1
  fi
  kill -TERM "$e2e_pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    [[ ! -r "/proc/$e2e_pid/stat" ]] && break
    [[ "$(awk '{print $3}' "/proc/$e2e_pid/stat" 2>/dev/null)" == "Z" ]] && break
    sleep 0.1
  done
  if kill -0 "$e2e_pid" 2>/dev/null && \
      [[ "$(awk '{print $3}' "/proc/$e2e_pid/stat" 2>/dev/null)" != "Z" ]]; then
    kill -KILL "$e2e_pid" 2>/dev/null || true
  fi
  wait "$e2e_pid" 2>/dev/null || true
}

e2e_cleanup() {
  local e2e_status="$1"
  local e2e_cleanup_failed=0
  trap - EXIT
  set +e
  if [[ -z "$e2e_endpoint_id" && -s "$e2e_endpoint_state" ]]; then
    e2e_endpoint_id="$(uv run python -c \
      'import json,sys; print(json.load(open(sys.argv[1]))["endpoint_id"])' \
      "$e2e_endpoint_state" 2>/dev/null || true)"
  fi
  if [[ "$e2e_webhook_create_started" -eq 1 ]]; then
    if ! STRIPE_API_VERSION="$e2e_request_version" \
        uv run python scripts/e2e_stripe.py write-cleanup-manifest \
        --database-url "$e2e_database_url" \
        --external-ref "$e2e_external_ref" \
        --endpoint-id "$e2e_endpoint_id" \
        --description "$e2e_description" \
        --url "$e2e_webhook_url" \
        --output "$e2e_cleanup_manifest" >/dev/null 2>&1; then
      echo "browser E2E cleanup manifest creation failed" >&2
      printf '{"endpoint_id":"%s","endpoint_description":"%s",' \
        "$e2e_endpoint_id" "$e2e_description" >"$e2e_cleanup_manifest"
      printf '"endpoint_url":"%s","external_ref":"%s",' \
        "$e2e_webhook_url" "$e2e_external_ref" >>"$e2e_cleanup_manifest"
      printf '"database_state_available":false}\n' >>"$e2e_cleanup_manifest"
      chmod 600 "$e2e_cleanup_manifest"
      e2e_cleanup_failed=1
    fi
  fi
  if [[ -n "$e2e_endpoint_id" ]]; then
    if ! STRIPE_API_VERSION="$e2e_request_version" \
        uv run python scripts/e2e_stripe.py cleanup-account \
        --database-url "$e2e_database_url" \
        --external-ref "$e2e_external_ref" >/dev/null 2>&1; then
      echo "browser E2E account cleanup failed" >&2
      e2e_cleanup_failed=1
    fi
    if ! STRIPE_API_VERSION="$e2e_request_version" \
        uv run python scripts/e2e_stripe.py delete-webhook \
        --endpoint-id "$e2e_endpoint_id" \
        --description "$e2e_description" >/dev/null 2>&1; then
      echo "browser E2E Webhook Endpoint cleanup failed" >&2
      e2e_cleanup_failed=1
    fi
  elif [[ "$e2e_webhook_create_started" -eq 1 && -n "$e2e_webhook_url" ]]; then
    if ! STRIPE_API_VERSION="$e2e_request_version" \
        uv run python scripts/e2e_stripe.py delete-webhook-by-description \
        --description "$e2e_description" \
        --url "$e2e_webhook_url" >/dev/null 2>&1; then
      echo "browser E2E Webhook Endpoint recovery sweep failed" >&2
      e2e_cleanup_failed=1
    fi
  fi
  if ! e2e_stop_pid "$e2e_frontend_pid" "$e2e_frontend_start"; then
    e2e_cleanup_failed=1
  fi
  if ! e2e_stop_pid "$e2e_backend_pid" "$e2e_backend_start"; then
    e2e_cleanup_failed=1
  fi
  if ! e2e_stop_pid "$e2e_tunnel_pid" "$e2e_tunnel_start"; then
    e2e_cleanup_failed=1
  fi
  case "$e2e_pg_container" in
    stripe-entitlements-browser-e2e-pg-[0-9]*)
      if ! docker rm -f "$e2e_pg_container" >/dev/null 2>&1; then
        echo "browser E2E PostgreSQL cleanup failed" >&2
        e2e_cleanup_failed=1
      fi
      ;;
  esac
  rm -f "$e2e_endpoint_state"
  if [[ "$e2e_cleanup_failed" -ne 0 && "$e2e_status" -eq 0 ]]; then
    e2e_status=1
  fi
  if [[ "$e2e_status" -eq 0 ]]; then
    case "$e2e_tmp_dir" in
      /tmp/stripe-entitlements-browser-e2e.*) rm -rf "$e2e_tmp_dir" ;;
    esac
  else
    echo "browser E2E failed; non-secret logs kept in $e2e_tmp_dir" >&2
  fi
  exit "$e2e_status"
}
trap 'e2e_cleanup $?' EXIT

for e2e_command in docker curl uv npm; do
  command -v "$e2e_command" >/dev/null || {
    echo "missing required command: $e2e_command" >&2
    exit 2
  }
done
if [[ ! -x "$e2e_cloudflared" ]] && ! command -v "$e2e_cloudflared" >/dev/null; then
  echo "cloudflared is required; set CLOUDFLARED_BIN to its executable" >&2
  exit 2
fi

docker run -d --rm --name "$e2e_pg_container" \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=512m \
  -e POSTGRES_DB=stripe_entitlements \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=local-only \
  -p "127.0.0.1:${e2e_pg_port}:5432" \
  "$e2e_postgres_image" >"$e2e_tmp_dir/postgres.id"

e2e_pg_ready=0
for _ in $(seq 1 60); do
  if docker exec "$e2e_pg_container" pg_isready -U postgres \
    -d stripe_entitlements >/dev/null 2>&1; then
    e2e_pg_ready=1
    break
  fi
  sleep 1
done
if [[ "$e2e_pg_ready" -ne 1 ]]; then
  docker logs "$e2e_pg_container" >"$e2e_tmp_dir/postgres.log" 2>&1 || true
  echo "disposable PostgreSQL did not become ready; inspect postgres.log" >&2
  exit 1
fi

uv run python scripts/e2e_stripe.py wait-database \
  --database-url "$e2e_database_url" --timeout-seconds 60

if ! env \
    DATABASE_URL="$e2e_database_url" \
    STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
    STRIPE_WEBHOOK_SECRET=whsec_browser_e2e_bootstrap \
    STRIPE_API_VERSION="$e2e_request_version" \
    STRIPE_WEBHOOK_API_VERSION="$e2e_event_version" \
    uv run stripe-entitlements migrate >"$e2e_tmp_dir/migrate.log" 2>&1; then
  echo "database migration failed; inspect migrate.log in the retained log directory" >&2
  exit 1
fi

"$e2e_cloudflared" tunnel --no-autoupdate \
  --url "$e2e_backend_url" >"$e2e_tmp_dir/cloudflared.log" 2>&1 &
e2e_tunnel_pid="$!"
e2e_tunnel_start="$(e2e_pid_start "$e2e_tunnel_pid")"
e2e_tunnel_url=""
for _ in $(seq 1 60); do
  e2e_tunnel_url="$(rg -o 'https://[-a-z0-9]+\.trycloudflare\.com' \
    "$e2e_tmp_dir/cloudflared.log" | tail -n 1 || true)"
  [[ -n "$e2e_tunnel_url" ]] && break
  sleep 1
done
if [[ -z "$e2e_tunnel_url" ]]; then
  echo "cloudflared did not publish a quick-tunnel URL" >&2
  exit 1
fi
e2e_webhook_url="${e2e_tunnel_url}/webhooks/stripe"

e2e_webhook_create_started=1
STRIPE_API_VERSION="$e2e_request_version" uv run python scripts/e2e_stripe.py \
  create-webhook --url "$e2e_webhook_url" \
  --event-api-version "$e2e_event_version" \
  --description "$e2e_description" --output "$e2e_endpoint_state"
e2e_endpoint_id="$(uv run python -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["endpoint_id"])' \
  "$e2e_endpoint_state")"
e2e_webhook_secret="$(uv run python -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["webhook_secret"])' \
  "$e2e_endpoint_state")"

STRIPE_API_VERSION="$e2e_request_version" uv run python scripts/e2e_stripe.py \
  verify-webhook --endpoint-id "$e2e_endpoint_id" --url "$e2e_webhook_url" \
  --event-api-version "$e2e_event_version"

env \
  DATABASE_URL="$e2e_database_url" \
  STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
  STRIPE_WEBHOOK_SECRET="$e2e_webhook_secret" \
  STRIPE_API_VERSION="$e2e_request_version" \
  STRIPE_WEBHOOK_API_VERSION="$e2e_event_version" \
  PRODUCT_LINE=example-entitlements \
  LOOKUP_PREFIX=ent \
  PLAN_CATALOG_PATH="$e2e_repo_root/plans.toml" \
  BILLING_TRANSITION_POLICY="$e2e_transition_policy" \
  CHECKOUT_SUCCESS_URL="${e2e_frontend_url}/billing/success" \
  CHECKOUT_CANCEL_URL="${e2e_frontend_url}/pricing" \
  PORTAL_RETURN_URL="${e2e_frontend_url}/account" \
  FRONTEND_ORIGINS="$e2e_frontend_url" \
  APP_ENV=development \
  DEMO_BEARER_TOKEN="$e2e_demo_token" \
  DEMO_BEARER_SUBJECT="$e2e_external_ref" \
  DEMO_BEARER_EMAIL="${e2e_external_ref}@example.test" \
  uv run uvicorn stripe_entitlements.app:create_app --factory \
    --host 127.0.0.1 --port "$e2e_backend_port" \
    >"$e2e_tmp_dir/backend.log" 2>&1 &
e2e_backend_pid="$!"
e2e_backend_start="$(e2e_pid_start "$e2e_backend_pid")"

for _ in $(seq 1 60); do
  curl -fsS "${e2e_backend_url}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "${e2e_backend_url}/health" >/dev/null

(
  cd web
  exec env -i \
    PATH="$e2e_child_path" \
    HOME="$e2e_child_home" \
    TMPDIR="$e2e_child_tmp" \
    LANG="$e2e_child_lang" \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_BILLING_API_MODE=http \
    NEXT_PUBLIC_BILLING_API_BASE_URL="$e2e_backend_url" \
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="$STRIPE_PUBLISHABLE_KEY" \
    NEXT_PUBLIC_DEMO_BEARER_TOKEN="$e2e_demo_token" \
    ./node_modules/.bin/next dev --hostname 127.0.0.1 \
      --port "$e2e_frontend_port"
) >"$e2e_tmp_dir/frontend.log" 2>&1 &
e2e_frontend_pid="$!"
e2e_frontend_start="$(e2e_pid_start "$e2e_frontend_pid")"

for _ in $(seq 1 90); do
  curl -fsS "${e2e_frontend_url}/pricing" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "${e2e_frontend_url}/pricing" >/dev/null

env \
  E2E_RUN_REAL_STRIPE=1 \
  E2E_STRIPE_MODE=test \
  E2E_BASE_URL="$e2e_frontend_url" \
  E2E_BACKEND_URL="$e2e_backend_url" \
  E2E_DATABASE_URL="$e2e_database_url" \
  E2E_EXTERNAL_REF="$e2e_external_ref" \
  E2E_DECLINE_STABILITY_SECONDS="${E2E_DECLINE_STABILITY_SECONDS:-10}" \
  E2E_TRANSITION_POLICY="$e2e_transition_policy" \
  E2E_UPGRADE_PAYMENT_METHOD="$e2e_upgrade_payment_method" \
  npm --prefix web run test:e2e:stripe

STRIPE_API_VERSION="$e2e_request_version" uv run python scripts/e2e_stripe.py \
  verify-database --database-url "$e2e_database_url" \
  --external-ref "$e2e_external_ref" \
  --event-api-version "$e2e_event_version" \
  --expected-plan pro --expected-credits 1000 \
  --transition-policy "$e2e_transition_policy"

echo "browser Stripe Checkout, $e2e_transition_policy upgrade, and signed webhook E2E passed"
