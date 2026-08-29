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

e2e_backend_implementation="${E2E_BACKEND_IMPLEMENTATION:-python}"
case "$e2e_backend_implementation" in
  python|typescript) ;;
  *) echo "E2E_BACKEND_IMPLEMENTATION must be python or typescript" >&2; exit 2 ;;
esac

e2e_request_version="${STRIPE_API_VERSION:-2026-06-24.dahlia}"
e2e_webhook_transport="${E2E_WEBHOOK_TRANSPORT:-endpoint}"
case "$e2e_webhook_transport" in
  endpoint|stripe_cli) ;;
  *) echo "E2E_WEBHOOK_TRANSPORT must be endpoint or stripe_cli" >&2; exit 2 ;;
esac
if [[ "$e2e_webhook_transport" == "stripe_cli" && -z "${E2E_STRIPE_EVENT_API_VERSION:-}" ]]; then
  echo "stripe_cli transport requires explicit E2E_STRIPE_EVENT_API_VERSION" >&2
  exit 2
fi
e2e_event_version="${E2E_STRIPE_EVENT_API_VERSION:-2026-06-24.dahlia}"
e2e_supported_events="checkout.session.completed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.dispute.created,payment_intent.succeeded"
e2e_transition_policy="${E2E_TRANSITION_POLICY:-full_period_reset}"
case "$e2e_transition_policy" in
  full_period_reset|prorated_delta) ;;
  *) echo "E2E_TRANSITION_POLICY must be full_period_reset or prorated_delta" >&2; exit 2 ;;
esac
e2e_upgrade_payment_method="${E2E_UPGRADE_PAYMENT_METHOD:-pm_card_authenticationRequired}"
e2e_record_video="${E2E_RECORD_VIDEO:-0}"
case "$e2e_record_video" in
  0|1) ;;
  *) echo "E2E_RECORD_VIDEO must be 0 or 1" >&2; exit 2 ;;
esac
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
e2e_user_id="$(uv run python -c 'import uuid; print(uuid.uuid4())')"
e2e_workload_subject="$(uv run python -c 'import uuid; print(uuid.uuid4())')"
e2e_external_ref="v1:user:${e2e_user_id}"
e2e_description="stripe-entitlements-browser-e2e-$e2e_run_id"
e2e_pg_container="stripe-entitlements-browser-e2e-pg-$$"
e2e_tmp_dir="$(mktemp -d /tmp/stripe-entitlements-browser-e2e.XXXXXX)"
e2e_typescript_build_dir="$e2e_tmp_dir/typescript-e2e"
e2e_endpoint_state="$e2e_tmp_dir/webhook.json"
e2e_cleanup_manifest="$e2e_tmp_dir/cleanup-manifest.json"
e2e_account_state="$e2e_tmp_dir/account.json"
e2e_auth_state="$e2e_tmp_dir/auth.json"
e2e_jwks_state="$e2e_tmp_dir/jwks.json"
e2e_gate_state_dir="$e2e_tmp_dir/webhook-gate"
e2e_endpoint_id=""
e2e_webhook_url=""
e2e_webhook_create_started=0
e2e_stateful_run_started=0
e2e_tunnel_pid=""
e2e_listener_pid=""
e2e_listener_log=""
e2e_gate_pid=""
e2e_backend_pid=""
e2e_frontend_pid=""
e2e_tunnel_start=""
e2e_listener_start=""
e2e_gate_start=""
e2e_backend_start=""
e2e_frontend_start=""
e2e_run_completed=0
e2e_browser_verified=0
e2e_database_verified=0
e2e_evidence_safe=1
e2e_commit_sha=""
e2e_git_dirty=""
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
e2e_gate_port="$(e2e_free_port)"
while [[ "$e2e_gate_port" == "$e2e_pg_port" || \
         "$e2e_gate_port" == "$e2e_backend_port" ]]; do
  e2e_gate_port="$(e2e_free_port)"
done
e2e_frontend_port="$(e2e_free_port)"
while [[ "$e2e_frontend_port" == "$e2e_pg_port" || \
         "$e2e_frontend_port" == "$e2e_backend_port" || \
         "$e2e_frontend_port" == "$e2e_gate_port" ]]; do
  e2e_frontend_port="$(e2e_free_port)"
done
e2e_database_url="postgresql://postgres:local-only@127.0.0.1:${e2e_pg_port}/stripe_entitlements"
e2e_backend_url="https://127.0.0.1:${e2e_backend_port}"
e2e_gate_url="http://127.0.0.1:${e2e_gate_port}"
e2e_frontend_url="https://127.0.0.1:${e2e_frontend_port}"
e2e_jwt_issuer="${e2e_backend_url}/e2e/issuer"
e2e_personal_audience="stripe-entitlements-browser-e2e"
e2e_workload_audience="stripe-entitlements-internal-e2e"
e2e_personal_token=""
e2e_workload_token=""
e2e_job_success_key="browser-e2e:${e2e_run_id}:job-success"
e2e_job_failure_key="browser-e2e:${e2e_run_id}:job-failure"
e2e_portal_configuration_id=""
e2e_output_root="${E2E_OUTPUT_DIR:-$e2e_repo_root/web/test-results/playwright-stripe-${e2e_backend_implementation}-${e2e_transition_policy}}"
e2e_output_dir=""
e2e_loopback_key="$e2e_tmp_dir/loopback.key"
e2e_loopback_cert="$e2e_tmp_dir/loopback.crt"
e2e_combined_ca="$e2e_tmp_dir/combined-ca.pem"
e2e_cloudflared_config="$e2e_tmp_dir/cloudflared-empty.yml"
e2e_loopback_spki=""

e2e_pid_start() {
  local e2e_pid="${1:-}"
  [[ "$e2e_pid" =~ ^[0-9]+$ && -r "/proc/$e2e_pid/stat" ]] || return 1
  awk '{print $22}' "/proc/$e2e_pid/stat"
}

e2e_bounded_curl() {
  command curl --connect-timeout 2 --max-time 5 "$@"
}

e2e_sanitize_evidence_tree() {
  local e2e_evidence_root="${1:-}"
  [[ -n "$e2e_evidence_root" && -d "$e2e_evidence_root" ]] || return 0
  uv run python scripts/sanitize_e2e_evidence.py --root "$e2e_evidence_root"
}

e2e_write_success_evidence() {
  [[ "$e2e_browser_verified" -eq 1 && \
     "$e2e_database_verified" -eq 1 && \
     "$e2e_run_completed" -eq 1 ]] || return 1
  [[ -n "$e2e_output_dir" && -d "$e2e_output_dir" ]] || return 1
  env -i \
    PATH="$e2e_child_path" \
    HOME="$e2e_child_home" \
    TMPDIR="$e2e_child_tmp" \
    LANG="$e2e_child_lang" \
    E2E_EVIDENCE_OUTPUT="$e2e_output_dir/evidence.json" \
    E2E_EVIDENCE_RUN_ID="$e2e_run_id" \
    E2E_EVIDENCE_COMMIT_SHA="$e2e_commit_sha" \
    E2E_EVIDENCE_GIT_DIRTY="$e2e_git_dirty" \
    E2E_EVIDENCE_BACKEND="$e2e_backend_implementation" \
    E2E_EVIDENCE_POLICY="$e2e_transition_policy" \
    E2E_EVIDENCE_TRANSPORT="$e2e_webhook_transport" \
    E2E_EVIDENCE_REQUEST_VERSION="$e2e_request_version" \
    E2E_EVIDENCE_EVENT_VERSION="$e2e_event_version" \
    uv run python - <<'PY'
# E2E_SUCCESS_EVIDENCE_PY_BEGIN
import json
import os
import re
import stat
from pathlib import Path


def required(name: str, pattern: str) -> str:
    value = os.environ.get(name, "")
    if not re.fullmatch(pattern, value):
        raise RuntimeError(f"invalid safe evidence field: {name}")
    return value


output = Path(os.environ["E2E_EVIDENCE_OUTPUT"])
parent = output.parent
parent_state = parent.lstat()
if (
    not parent.is_absolute()
    or stat.S_ISLNK(parent_state.st_mode)
    or not stat.S_ISDIR(parent_state.st_mode)
):
    raise RuntimeError("unsafe evidence output directory")
if output.exists() or output.is_symlink():
    raise RuntimeError("refusing to replace an existing evidence file")

dirty_value = required("E2E_EVIDENCE_GIT_DIRTY", r"[01]")
document = {
    "schema_version": 1,
    "run_id": required("E2E_EVIDENCE_RUN_ID", r"[0-9]{14}-[0-9]+"),
    "source": {
        "commit_sha": required("E2E_EVIDENCE_COMMIT_SHA", r"[0-9a-f]{40,64}"),
        "dirty": dirty_value == "1",
    },
    "backend_implementation": required(
        "E2E_EVIDENCE_BACKEND", r"python|typescript"
    ),
    "transition_policy": required(
        "E2E_EVIDENCE_POLICY", r"full_period_reset|prorated_delta"
    ),
    "webhook_transport": required(
        "E2E_EVIDENCE_TRANSPORT", r"endpoint|stripe_cli"
    ),
    "stripe_api_versions": {
        "request": required(
            "E2E_EVIDENCE_REQUEST_VERSION", r"[0-9]{4}-[0-9]{2}-[0-9]{2}\.[A-Za-z0-9_-]+"
        ),
        "event": required(
            "E2E_EVIDENCE_EVENT_VERSION", r"[0-9]{4}-[0-9]{2}-[0-9]{2}\.[A-Za-z0-9_-]+"
        ),
    },
    "verification": {
        "browser_e2e": "passed",
        "database_verifier": "passed",
        "cleanup": "passed",
    },
}
temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(document, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(output)
    if stat.S_IMODE(output.stat().st_mode) != 0o600:
        raise RuntimeError("evidence mode is not exactly 0600")
except BaseException:
    temporary.unlink(missing_ok=True)
    output.unlink(missing_ok=True)
    raise
# E2E_SUCCESS_EVIDENCE_PY_END
PY
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
  if [[ ! -d "$e2e_tmp_dir" ]]; then
    case "$e2e_tmp_dir" in
      /tmp/stripe-entitlements-browser-e2e.*)
        if ! mkdir -p "$e2e_tmp_dir" || ! chmod 700 "$e2e_tmp_dir"; then
          echo "browser E2E could not recreate its private cleanup directory" >&2
          e2e_cleanup_failed=1
        fi
        ;;
      *)
        echo "browser E2E cleanup directory has an unsafe path" >&2
        e2e_cleanup_failed=1
        ;;
    esac
  fi
  if [[ -z "$e2e_endpoint_id" && -s "$e2e_endpoint_state" ]]; then
    e2e_endpoint_id="$(uv run python -c \
      'import json,sys; print(json.load(open(sys.argv[1]))["endpoint_id"])' \
      "$e2e_endpoint_state" 2>/dev/null || true)"
  fi
  if [[ "$e2e_stateful_run_started" -eq 1 ]]; then
    if ! STRIPE_API_VERSION="$e2e_request_version" \
        uv run python scripts/e2e_stripe.py write-cleanup-manifest \
        --database-url "$e2e_database_url" \
        --external-ref "$e2e_external_ref" \
        --endpoint-id "$e2e_endpoint_id" \
        --description "$e2e_description" \
        --url "$e2e_webhook_url" \
        --output "$e2e_cleanup_manifest" >/dev/null 2>&1; then
      echo "browser E2E cleanup manifest creation failed" >&2
      if [[ ! -e "$e2e_cleanup_manifest" && ! -L "$e2e_cleanup_manifest" ]]; then
        printf '{"endpoint_id":"%s","endpoint_description":"%s",' \
          "$e2e_endpoint_id" "$e2e_description" >"$e2e_cleanup_manifest"
        printf '"endpoint_url":"%s","external_ref":"%s",' \
          "$e2e_webhook_url" "$e2e_external_ref" >>"$e2e_cleanup_manifest"
        printf '"database_state_available":false}\n' >>"$e2e_cleanup_manifest"
        chmod 600 "$e2e_cleanup_manifest"
      else
        echo "preserving the previously seeded cleanup manifest" >&2
      fi
      e2e_cleanup_failed=1
    fi
  fi
  if [[ "$e2e_stateful_run_started" -eq 1 ]]; then
    if ! STRIPE_API_VERSION="$e2e_request_version" \
        uv run python scripts/e2e_stripe.py cleanup-account \
        --database-url "$e2e_database_url" \
        --external-ref "$e2e_external_ref" >/dev/null 2>&1; then
      echo "browser E2E account cleanup failed" >&2
      e2e_cleanup_failed=1
    fi
  fi
  if [[ -n "$e2e_endpoint_id" ]]; then
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
  if ! e2e_stop_pid "$e2e_listener_pid" "$e2e_listener_start"; then
    e2e_cleanup_failed=1
  fi
  if ! e2e_stop_pid "$e2e_backend_pid" "$e2e_backend_start"; then
    e2e_cleanup_failed=1
  fi
  if ! e2e_stop_pid "$e2e_tunnel_pid" "$e2e_tunnel_start"; then
    e2e_cleanup_failed=1
  fi
  if ! e2e_stop_pid "$e2e_gate_pid" "$e2e_gate_start"; then
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
  if ! rm -f "$e2e_endpoint_state" "$e2e_auth_state" "$e2e_jwks_state" \
      "$e2e_loopback_key" "$e2e_cloudflared_config"; then
    echo "browser E2E credential-state cleanup failed" >&2
    e2e_cleanup_failed=1
  fi
  if ! e2e_sanitize_evidence_tree "$e2e_tmp_dir" >/dev/null; then
    echo "browser E2E could not prove retained service evidence is secret-free" >&2
    e2e_cleanup_failed=1
    e2e_evidence_safe=0
  fi
  if ! e2e_sanitize_evidence_tree "$e2e_output_dir" >/dev/null; then
    echo "browser E2E could not prove retained Playwright evidence is secret-free" >&2
    e2e_cleanup_failed=1
    e2e_evidence_safe=0
  fi
  if [[ "$e2e_status" -eq 0 && "$e2e_run_completed" -ne 1 ]]; then
    echo "browser E2E exited before final database verification" >&2
    e2e_cleanup_failed=1
  fi
  if [[ "$e2e_status" -eq 0 && \
        ( "$e2e_browser_verified" -ne 1 || "$e2e_database_verified" -ne 1 ) ]]; then
    echo "browser E2E verifier status is incomplete" >&2
    e2e_cleanup_failed=1
  fi
  if [[ "$e2e_cleanup_failed" -ne 0 && "$e2e_status" -eq 0 ]]; then
    e2e_status=1
  fi
  if [[ "$e2e_status" -eq 0 ]]; then
    case "$e2e_tmp_dir" in
      /tmp/stripe-entitlements-browser-e2e.*)
        if ! rm -rf "$e2e_tmp_dir"; then
          echo "browser E2E private temporary directory cleanup failed" >&2
          e2e_status=1
        fi
        ;;
      *)
        echo "browser E2E cleanup directory has an unsafe path" >&2
        e2e_status=1
        ;;
    esac
  fi
  if [[ "$e2e_status" -eq 0 ]]; then
    if ! e2e_write_success_evidence; then
      echo "browser E2E could not write its success evidence" >&2
      rm -f "$e2e_output_dir/evidence.json"
      e2e_status=1
    elif ! e2e_sanitize_evidence_tree "$e2e_output_dir" >/dev/null; then
      echo "browser E2E success evidence did not pass the secret scan" >&2
      rm -f "$e2e_output_dir/evidence.json"
      e2e_evidence_safe=0
      e2e_status=1
    fi
  fi
  if [[ "$e2e_status" -eq 0 ]]; then
    echo "browser Personal JWT, Stripe Checkout/Portal, $e2e_transition_policy upgrade, Boost 100 pack, product Job charge/refund, signed webhook, $e2e_backend_implementation backend, and cleanup E2E passed"
    echo "browser E2E artifacts: $e2e_output_dir"
    if [[ "$e2e_record_video" == "1" ]]; then
      find "$e2e_output_dir" -type f -name '*.webm' -print | while read -r video_path; do
        echo "recorded video: $video_path"
      done
    fi
  elif [[ "$e2e_evidence_safe" -eq 1 && -d "$e2e_tmp_dir" ]]; then
    echo "browser E2E failed; sanitized private logs kept in $e2e_tmp_dir" >&2
  elif [[ "$e2e_evidence_safe" -eq 1 ]]; then
    echo "browser E2E failed after private cleanup; sanitized artifacts kept in $e2e_output_dir" >&2
  else
    echo "browser E2E failed and retained evidence did not pass the secret scan" >&2
  fi
  exit "$e2e_status"
}
trap 'e2e_cleanup $?' EXIT

for e2e_command in docker curl git uv npm node openssl; do
  command -v "$e2e_command" >/dev/null || {
    echo "missing required command: $e2e_command" >&2
    exit 2
  }
done

if ! e2e_commit_sha="$(git rev-parse --verify HEAD^{commit})" || \
    [[ ! "$e2e_commit_sha" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "browser E2E could not resolve its source commit" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain=v1 --untracked-files=normal)" ]]; then
  e2e_git_dirty=1
else
  e2e_git_dirty=0
fi

umask 077
if ! mkdir -p -- "$e2e_output_root"; then
  echo "browser E2E could not create its artifact root" >&2
  exit 1
fi
if ! e2e_output_root="$(cd "$e2e_output_root" && pwd -P)"; then
  echo "browser E2E could not resolve its artifact root" >&2
  exit 1
fi
if ! e2e_output_dir="$(
    mktemp -d -- "$e2e_output_root/run-${e2e_backend_implementation}-${e2e_transition_policy}-${e2e_run_id}.XXXXXX"
  )"; then
  echo "browser E2E could not create a unique artifact directory" >&2
  exit 1
fi
echo "browser E2E artifact directory: $e2e_output_dir"
if ! openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$e2e_loopback_key" -out "$e2e_loopback_cert" \
    -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    >"$e2e_tmp_dir/openssl.log" 2>&1; then
  echo "browser E2E could not create its ephemeral loopback TLS certificate" >&2
  exit 1
fi
chmod 600 "$e2e_loopback_key" "$e2e_loopback_cert"
E2E_LOOPBACK_CERT="$e2e_loopback_cert" E2E_COMBINED_CA="$e2e_combined_ca" \
  uv run python -c '
import os
from pathlib import Path

import certifi

system_ca = Path(certifi.where()).read_bytes()
loopback_ca = Path(os.environ["E2E_LOOPBACK_CERT"]).read_bytes()
output = Path(os.environ["E2E_COMBINED_CA"])
output.write_bytes(system_ca.rstrip() + b"\n" + loopback_ca.rstrip() + b"\n")
output.chmod(0o600)
'
if ! e2e_loopback_spki="$(
    openssl x509 -in "$e2e_loopback_cert" -pubkey -noout |
      openssl pkey -pubin -outform DER |
      openssl dgst -sha256 -binary |
      openssl base64 -A
  )" 2>>"$e2e_tmp_dir/openssl.log"; then
  echo "browser E2E could not derive its loopback certificate SPKI pin" >&2
  exit 1
fi
if [[ ! "$e2e_loopback_spki" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
  echo "browser E2E derived an invalid loopback certificate SPKI pin" >&2
  exit 1
fi

uv run python scripts/e2e_stripe.py create-auth-fixture \
  --issuer "$e2e_jwt_issuer" \
  --personal-audience "$e2e_personal_audience" \
  --personal-subject "$e2e_user_id" \
  --email "${e2e_user_id}@example.test" \
  --workload-audience "$e2e_workload_audience" \
  --workload-subject "$e2e_workload_subject" \
  --jwks-output "$e2e_jwks_state" \
  --token-output "$e2e_auth_state" >/dev/null
e2e_personal_token="$(E2E_AUTH_STATE="$e2e_auth_state" uv run python -c '
import json
import os
from pathlib import Path

state = json.loads(Path(os.environ["E2E_AUTH_STATE"]).read_text(encoding="utf-8"))
print(state["personal_token"])
')"
e2e_workload_token="$(E2E_AUTH_STATE="$e2e_auth_state" uv run python -c '
import json
import os
from pathlib import Path

state = json.loads(Path(os.environ["E2E_AUTH_STATE"]).read_text(encoding="utf-8"))
print(state["workload_token"])
')"
if [[ ! "$e2e_personal_token" =~ ^eyJ[A-Za-z0-9._-]+$ || \
      ! "$e2e_workload_token" =~ ^eyJ[A-Za-z0-9._-]+$ ]]; then
  echo "browser E2E auth fixture did not produce signed JWTs" >&2
  exit 1
fi

if ! STRIPE_API_VERSION="$e2e_request_version" \
    uv run python scripts/bootstrap_stripe.py --verify-only \
    --catalog "$e2e_repo_root/plans.toml" \
    --product-line example-entitlements \
    >"$e2e_tmp_dir/stripe-catalog-verify.log" 2>&1; then
  echo "Stripe test catalog or Portal verification failed; inspect stripe-catalog-verify.log" >&2
  exit 1
fi
e2e_portal_configuration_id="$(
  rg -o 'portal=bpc_[A-Za-z0-9_]+' "$e2e_tmp_dir/stripe-catalog-verify.log" |
    tail -n 1 | sed 's/^portal=//'
)"
if [[ ! "$e2e_portal_configuration_id" =~ ^bpc_[A-Za-z0-9_]+$ ]]; then
  echo "verified Stripe test catalog did not expose one Portal configuration" >&2
  exit 1
fi

if [[ "$e2e_webhook_transport" == "endpoint" ]]; then
  if [[ ! -x "$e2e_cloudflared" ]] && ! command -v "$e2e_cloudflared" >/dev/null; then
    echo "cloudflared is required; set CLOUDFLARED_BIN to its executable" >&2
    exit 2
  fi
elif ! command -v stripe >/dev/null; then
  echo "Stripe CLI is required for E2E_WEBHOOK_TRANSPORT=stripe_cli" >&2
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

# E2E_BACKEND_MIGRATION_BEGIN
if [[ "$e2e_backend_implementation" == "python" ]]; then
  if ! env -i \
      PATH="$e2e_child_path" \
      HOME="$e2e_child_home" \
      TMPDIR="$e2e_child_tmp" \
      LANG="$e2e_child_lang" \
      DATABASE_URL="$e2e_database_url" \
      STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
      STRIPE_WEBHOOK_SECRET=whsec_browser_e2e_bootstrap \
      STRIPE_API_VERSION="$e2e_request_version" \
      STRIPE_WEBHOOK_API_VERSION="$e2e_event_version" \
      uv run stripe-entitlements migrate >"$e2e_tmp_dir/migrate.log" 2>&1; then
    echo "Python database migration failed; inspect migrate.log in the retained log directory" >&2
    exit 1
  fi
else
  if ! (
    cd typescript
    ./node_modules/.bin/tsc -p tsconfig.e2e.json \
      --outDir "$e2e_typescript_build_dir"
  ) >"$e2e_tmp_dir/typescript-build.log" 2>&1; then
    echo "TypeScript E2E host build failed; inspect typescript-build.log" >&2
    exit 1
  fi
  cp -R "$e2e_repo_root/migrations" "$e2e_typescript_build_dir/migrations"
  cp "$e2e_repo_root/plans.toml" "$e2e_typescript_build_dir/plans.toml"
  if ! env -i \
      PATH="$e2e_child_path" \
      HOME="$e2e_child_home" \
      TMPDIR="$e2e_child_tmp" \
      LANG="$e2e_child_lang" \
      DATABASE_URL="$e2e_database_url" \
      node "$e2e_typescript_build_dir/src/node/bin.js" migrate \
      >"$e2e_tmp_dir/migrate.log" 2>&1; then
    echo "TypeScript database migration failed; inspect migrate.log in the retained log directory" >&2
    exit 1
  fi
fi
# E2E_BACKEND_MIGRATION_END

e2e_stateful_run_started=1
mkdir -m 700 "$e2e_gate_state_dir"
(
  exec env -i \
    PATH="$e2e_child_path" \
    HOME="$e2e_child_home" \
    TMPDIR="$e2e_child_tmp" \
    LANG="$e2e_child_lang" \
    E2E_WEBHOOK_GATE_STATE_DIR="$e2e_gate_state_dir" \
    E2E_WEBHOOK_GATE_BACKEND_URL="${e2e_backend_url}/webhooks/stripe" \
    E2E_WEBHOOK_GATE_CA_FILE="$e2e_loopback_cert" \
    uv run uvicorn scripts.e2e_stripe:create_webhook_gate --factory \
      --host 127.0.0.1 --port "$e2e_gate_port" --no-access-log
) >"$e2e_tmp_dir/webhook-gate.log" 2>&1 &
e2e_gate_pid="$!"
e2e_gate_start="$(e2e_pid_start "$e2e_gate_pid")"
for _ in $(seq 1 60); do
  e2e_bounded_curl -fsS "${e2e_gate_url}/health" >/dev/null 2>&1 && break
  sleep 0.25
done
e2e_bounded_curl -fsS "${e2e_gate_url}/health" >/dev/null

if [[ "$e2e_webhook_transport" == "endpoint" ]]; then
  E2E_CLOUDFLARED_CONFIG="$e2e_cloudflared_config" uv run python -c '
import os
from pathlib import Path

path = Path(os.environ["E2E_CLOUDFLARED_CONFIG"])
path.write_text("{}\n", encoding="utf-8")
path.chmod(0o600)
'
  (
    exec env -i \
      PATH="$e2e_child_path" \
      HOME="$e2e_child_home" \
      TMPDIR="$e2e_child_tmp" \
      LANG="$e2e_child_lang" \
      "$e2e_cloudflared" tunnel --no-autoupdate \
        --config "$e2e_cloudflared_config" --no-tls-verify \
        --url "$e2e_gate_url"
  ) >"$e2e_tmp_dir/cloudflared.log" 2>&1 &
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

  # E2E_ENDPOINT_TUNNEL_PREFLIGHT_BEGIN
  e2e_public_tunnel_ready=0
  for _ in $(seq 1 60); do
    if e2e_bounded_curl -fsS "${e2e_tunnel_url}/health" >/dev/null 2>&1; then
      e2e_public_tunnel_ready=1
      break
    fi
    sleep 1
  done
  if [[ "$e2e_public_tunnel_ready" -ne 1 ]]; then
    echo "public webhook tunnel did not reach the isolated gate" >&2
    exit 1
  fi
  # E2E_ENDPOINT_TUNNEL_PREFLIGHT_END

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
else
  e2e_webhook_url="${e2e_gate_url}/webhooks/stripe"
  e2e_listener_log="$e2e_tmp_dir/stripe-listen.log"
  (
    exec env -i \
      PATH="$e2e_child_path" \
      HOME="$e2e_child_home" \
      TMPDIR="$e2e_child_tmp" \
      LANG="$e2e_child_lang" \
      STRIPE_API_KEY="$STRIPE_SECRET_KEY" \
      stripe listen --skip-update --skip-verify \
        --events "$e2e_supported_events" \
        --forward-to "$e2e_webhook_url"
  ) >"$e2e_listener_log" 2>&1 &
  e2e_listener_pid="$!"
  e2e_listener_start="$(e2e_pid_start "$e2e_listener_pid")"
  chmod 600 "$e2e_listener_log"
  e2e_webhook_secret=""
  for _ in $(seq 1 60); do
    e2e_webhook_secret="$(rg -o 'whsec_[A-Za-z0-9]+' "$e2e_listener_log" | head -n 1 || true)"
    [[ -n "$e2e_webhook_secret" ]] && break
    kill -0 "$e2e_listener_pid" 2>/dev/null || break
    sleep 1
  done
  if [[ -z "$e2e_webhook_secret" ]]; then
    echo "Stripe CLI did not expose a signing secret" >&2
    exit 1
  fi
  observed_listener_version="$(rg -o '[0-9]{4}-[0-9]{2}-[0-9]{2}\.[A-Za-z0-9_-]+' \
    "$e2e_listener_log" | head -n 1 || true)"
  if [[ -n "$observed_listener_version" && \
        "$observed_listener_version" != "$e2e_event_version" ]]; then
    echo "Stripe CLI Event version differs from E2E_STRIPE_EVENT_API_VERSION" >&2
    exit 1
  fi
  echo "verified Stripe CLI signed forwarding: api_version=$e2e_event_version events=9"
fi

# E2E_BACKEND_START_ENV_BEGIN
if [[ "$e2e_backend_implementation" == "python" ]]; then
  (
    exec env -i \
      PATH="$e2e_child_path" \
      HOME="$e2e_child_home" \
      TMPDIR="$e2e_child_tmp" \
      LANG="$e2e_child_lang" \
      SSL_CERT_FILE="$e2e_combined_ca" \
      DATABASE_URL="$e2e_database_url" \
      STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
      STRIPE_WEBHOOK_SECRET="$e2e_webhook_secret" \
      STRIPE_API_VERSION="$e2e_request_version" \
      STRIPE_WEBHOOK_API_VERSION="$e2e_event_version" \
      STRIPE_PORTAL_CONFIGURATION_ID="$e2e_portal_configuration_id" \
      PRODUCT_LINE=example-entitlements \
      LOOKUP_PREFIX=ent \
      PLAN_CATALOG_PATH="$e2e_repo_root/plans.toml" \
      BILLING_TRANSITION_POLICY="$e2e_transition_policy" \
      CHECKOUT_SUCCESS_URL="${e2e_frontend_url}/billing/success" \
      CHECKOUT_CANCEL_URL="${e2e_frontend_url}/pricing" \
      PORTAL_RETURN_URL="${e2e_frontend_url}/account" \
      FRONTEND_ORIGINS="$e2e_frontend_url" \
      APP_ENV=production \
      E2E_PERSONAL_JWKS_FILE="$e2e_jwks_state" \
      E2E_JWT_ISSUER="$e2e_jwt_issuer" \
      E2E_PERSONAL_JWT_AUDIENCE="$e2e_personal_audience" \
      E2E_WORKLOAD_JWT_AUDIENCE="$e2e_workload_audience" \
      E2E_WORKLOAD_SUBJECT="$e2e_workload_subject" \
      E2E_WORKLOAD_JWT="$e2e_workload_token" \
      E2E_EXPECTED_OWNER_EXTERNAL_REF="$e2e_external_ref" \
      E2E_JOB_SUCCESS_KEY="$e2e_job_success_key" \
      E2E_JOB_FAILURE_KEY="$e2e_job_failure_key" \
      uv run uvicorn scripts.browser_e2e_app:create_app --factory \
        --host 127.0.0.1 --port "$e2e_backend_port" \
        --ssl-keyfile "$e2e_loopback_key" --ssl-certfile "$e2e_loopback_cert"
  ) >"$e2e_tmp_dir/backend.log" 2>&1 &
else
  (
    exec env -i \
      PATH="$e2e_child_path" \
      HOME="$e2e_child_home" \
      TMPDIR="$e2e_child_tmp" \
      LANG="$e2e_child_lang" \
      NODE_EXTRA_CA_CERTS="$e2e_loopback_cert" \
      DATABASE_URL="$e2e_database_url" \
      STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
      STRIPE_WEBHOOK_SECRET="$e2e_webhook_secret" \
      STRIPE_API_VERSION="$e2e_request_version" \
      STRIPE_WEBHOOK_API_VERSION="$e2e_event_version" \
      STRIPE_PORTAL_CONFIGURATION_ID="$e2e_portal_configuration_id" \
      PRODUCT_LINE=example-entitlements \
      LOOKUP_PREFIX=ent \
      PLAN_CATALOG_PATH="$e2e_repo_root/plans.toml" \
      BILLING_TRANSITION_POLICY="$e2e_transition_policy" \
      CHECKOUT_SUCCESS_URL="${e2e_frontend_url}/billing/success" \
      CHECKOUT_CANCEL_URL="${e2e_frontend_url}/pricing" \
      PORTAL_RETURN_URL="${e2e_frontend_url}/account" \
      FRONTEND_ORIGINS="$e2e_frontend_url" \
      APP_ENV=production \
      E2E_BACKEND_HOST=127.0.0.1 \
      E2E_BACKEND_PORT="$e2e_backend_port" \
      E2E_TLS_KEY_FILE="$e2e_loopback_key" \
      E2E_TLS_CERT_FILE="$e2e_loopback_cert" \
      E2E_PERSONAL_JWKS_FILE="$e2e_jwks_state" \
      E2E_JWT_ISSUER="$e2e_jwt_issuer" \
      E2E_PERSONAL_JWT_AUDIENCE="$e2e_personal_audience" \
      E2E_WORKLOAD_JWT_AUDIENCE="$e2e_workload_audience" \
      E2E_WORKLOAD_SUBJECT="$e2e_workload_subject" \
      E2E_WORKLOAD_JWT="$e2e_workload_token" \
      E2E_EXPECTED_OWNER_EXTERNAL_REF="$e2e_external_ref" \
      E2E_JOB_SUCCESS_KEY="$e2e_job_success_key" \
      E2E_JOB_FAILURE_KEY="$e2e_job_failure_key" \
      node "$e2e_typescript_build_dir/tests/e2e/browser-host.js"
  ) >"$e2e_tmp_dir/backend.log" 2>&1 &
fi
# E2E_BACKEND_START_ENV_END
e2e_backend_pid="$!"
e2e_backend_start="$(e2e_pid_start "$e2e_backend_pid")"

for _ in $(seq 1 60); do
  e2e_bounded_curl --cacert "$e2e_loopback_cert" -fsS \
    "${e2e_backend_url}/health" >/dev/null 2>&1 && break
  sleep 1
done
e2e_bounded_curl --cacert "$e2e_loopback_cert" -fsS \
  "${e2e_backend_url}/health" >/dev/null
e2e_bounded_curl -fsS "${e2e_gate_url}/ready" >/dev/null
if [[ "$e2e_webhook_transport" == "endpoint" ]]; then
  e2e_public_backend_ready=0
  for _ in $(seq 1 60); do
    if e2e_bounded_curl -fsS "${e2e_tunnel_url}/ready" >/dev/null 2>&1; then
      e2e_public_backend_ready=1
      break
    fi
    sleep 1
  done
  if [[ "$e2e_public_backend_ready" -ne 1 ]]; then
    echo "public webhook tunnel did not reach the backend health endpoint" >&2
    exit 1
  fi
elif ! kill -0 "$e2e_listener_pid" 2>/dev/null; then
  echo "Stripe CLI listener exited before browser execution" >&2
  exit 1
fi

# E2E_CLEANUP_MANIFEST_SEED_BEGIN
e2e_bounded_curl --cacert "$e2e_loopback_cert" -fsS \
  -H "Authorization: Bearer $e2e_personal_token" \
  "${e2e_backend_url}/api/account" >"$e2e_account_state"
e2e_account_id="$(E2E_ACCOUNT_STATE="$e2e_account_state" uv run python -c '
import json
import os
from pathlib import Path

account = json.loads(Path(os.environ["E2E_ACCOUNT_STATE"]).read_text(encoding="utf-8"))
account_id = account.get("account_id")
if not isinstance(account_id, str) or not account_id:
    raise RuntimeError("authenticated account response has no account_id")
print(account_id)
')"
uv run python scripts/e2e_stripe.py arm-credit-pack-gate \
  --state-dir "$e2e_gate_state_dir" --account-id "$e2e_account_id"
STRIPE_API_VERSION="$e2e_request_version" \
  uv run python scripts/e2e_stripe.py write-cleanup-manifest \
  --database-url "$e2e_database_url" \
  --external-ref "$e2e_external_ref" \
  --endpoint-id "$e2e_endpoint_id" \
  --description "$e2e_description" \
  --url "$e2e_webhook_url" \
  --output "$e2e_cleanup_manifest"
E2E_ACCOUNT_STATE="$e2e_account_state" \
E2E_CLEANUP_MANIFEST="$e2e_cleanup_manifest" \
  uv run python -c '
import json
import os
import stat
from pathlib import Path

account = json.loads(Path(os.environ["E2E_ACCOUNT_STATE"]).read_text(encoding="utf-8"))
manifest_path = Path(os.environ["E2E_CLEANUP_MANIFEST"])
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
account_id = account.get("account_id")
if not isinstance(account_id, str) or not account_id:
    raise RuntimeError("authenticated account response has no account_id")
if manifest.get("account_id") != account_id:
    raise RuntimeError("cleanup manifest is not bound to the authenticated account")
if stat.S_IMODE(manifest_path.stat().st_mode) != 0o600:
    raise RuntimeError("cleanup manifest mode is not exactly 0600")
'
# E2E_CLEANUP_MANIFEST_SEED_END

# E2E_FRONTEND_BUILD_ENV_BEGIN
if ! (
  cd web
  exec env -i \
    PATH="$e2e_child_path" \
    HOME="$e2e_child_home" \
    TMPDIR="$e2e_child_tmp" \
    LANG="$e2e_child_lang" \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_BILLING_API_MODE=http \
    NEXT_PUBLIC_BILLING_API_BASE_URL="$e2e_backend_url" \
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="$STRIPE_PUBLISHABLE_KEY" \
    NEXT_PUBLIC_ALLOW_INDEXING=false \
    E2E_ALLOW_PRODUCTION_ROUTE_AUTH=1 \
    ./node_modules/.bin/next build
) >"$e2e_tmp_dir/frontend-build.log" 2>&1; then
  echo "production frontend build failed; inspect the retained frontend-build.log" >&2
  exit 1
fi
# E2E_FRONTEND_BUILD_ENV_END
if [[ ! -s "$e2e_repo_root/web/.next/BUILD_ID" ]]; then
  echo "production frontend build did not create a BUILD_ID" >&2
  exit 1
fi

# E2E_FRONTEND_START_ENV_BEGIN
(
  cd web
  exec env -i \
    PATH="$e2e_child_path" \
    HOME="$e2e_child_home" \
    TMPDIR="$e2e_child_tmp" \
    LANG="$e2e_child_lang" \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_BILLING_API_MODE=http \
    NEXT_PUBLIC_BILLING_API_BASE_URL="$e2e_backend_url" \
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="$STRIPE_PUBLISHABLE_KEY" \
    NEXT_PUBLIC_ALLOW_INDEXING=false \
    E2E_ALLOW_PRODUCTION_ROUTE_AUTH=1 \
    E2E_HTTPS_HOST=127.0.0.1 \
    E2E_HTTPS_PORT="$e2e_frontend_port" \
    E2E_HTTPS_KEY_FILE="$e2e_loopback_key" \
    E2E_HTTPS_CERT_FILE="$e2e_loopback_cert" \
    node ./scripts/serve-production-https.mjs
) >"$e2e_tmp_dir/frontend.log" 2>&1 &
# E2E_FRONTEND_START_ENV_END
e2e_frontend_pid="$!"
e2e_frontend_start="$(e2e_pid_start "$e2e_frontend_pid")"

for _ in $(seq 1 90); do
  e2e_bounded_curl --cacert "$e2e_loopback_cert" -fsS \
    "${e2e_frontend_url}/pricing" >/dev/null 2>&1 && break
  sleep 1
done
e2e_bounded_curl --cacert "$e2e_loopback_cert" -fsS \
  "${e2e_frontend_url}/pricing" >/dev/null

# E2E_PLAYWRIGHT_ENV_BEGIN
(
exec env -i \
  PATH="$e2e_child_path" \
  HOME="$e2e_child_home" \
  TMPDIR="$e2e_child_tmp" \
  LANG="$e2e_child_lang" \
  NODE_EXTRA_CA_CERTS="$e2e_loopback_cert" \
  STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
  STRIPE_API_VERSION="$e2e_request_version" \
  E2E_RUN_REAL_STRIPE=1 \
  E2E_STRIPE_MODE=test \
  E2E_BASE_URL="$e2e_frontend_url" \
  E2E_BACKEND_URL="$e2e_backend_url" \
  E2E_DATABASE_URL="$e2e_database_url" \
  E2E_FULL_STACK_EVIDENCE=1 \
  E2E_BACKEND_IMPLEMENTATION="$e2e_backend_implementation" \
  E2E_PERSONAL_BEARER_TOKEN="$e2e_personal_token" \
  E2E_EXTERNAL_REF="$e2e_external_ref" \
  E2E_JOB_SUCCESS_KEY="$e2e_job_success_key" \
  E2E_JOB_FAILURE_KEY="$e2e_job_failure_key" \
  E2E_WEBHOOK_GATE_STATE_DIR="$e2e_gate_state_dir" \
  E2E_FRONTEND_BUILD_MODE=production \
  E2E_LOOPBACK_TLS_SPKI="$e2e_loopback_spki" \
  E2E_WEBHOOK_TIMEOUT_MS="${E2E_WEBHOOK_TIMEOUT_MS:-180000}" \
  E2E_DECLINE_STABILITY_SECONDS="${E2E_DECLINE_STABILITY_SECONDS:-10}" \
  E2E_TRANSITION_POLICY="$e2e_transition_policy" \
  E2E_UPGRADE_PAYMENT_METHOD="$e2e_upgrade_payment_method" \
  E2E_RECORD_VIDEO="$e2e_record_video" \
  E2E_DEMO_PAUSE_MS="${E2E_DEMO_PAUSE_MS:-0}" \
  E2E_OUTPUT_DIR="$e2e_output_dir" \
  npm --prefix web run test:e2e:stripe
)
# E2E_PLAYWRIGHT_ENV_END
e2e_browser_verified=1

STRIPE_API_VERSION="$e2e_request_version" uv run python scripts/e2e_stripe.py \
  verify-database --database-url "$e2e_database_url" \
  --external-ref "$e2e_external_ref" \
  --event-api-version "$e2e_event_version" \
  --delivery-transport "$e2e_webhook_transport" \
  --expected-plan pro --expected-credits 1020 \
  --expected-pack boost-100 --expected-pack-credits 100 \
  --expected-pack-price 1500 --expected-pack-currency usd \
  --expected-pack-expires-days 365 --expected-pack-lookup-key ent_pack_boost-100 \
  --expected-success-job-key "$e2e_job_success_key" \
  --expected-success-job-credits 80 \
  --expected-refunded-job-key "$e2e_job_failure_key" \
  --expected-refunded-job-credits 20 \
  --transition-policy "$e2e_transition_policy"
e2e_database_verified=1
e2e_run_completed=1
