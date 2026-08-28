#!/usr/bin/env bash
# Rebuilds the site and (re)starts a long-lived production preview for hero
# review rounds.
#
#   scripts/hero_preview.sh [port]
#
# Separate from `run_hero_webgl.sh`, which owns a server for the length of one
# Playwright run and tears it down again. A visual tuning round wants the
# opposite: many captures against one server, rebuilt in place.
#
# The restart is the fiddly part. `next start` keeps serving the build it was
# started with, and a rebuild deletes the chunk files that build's HTML points
# at, so a preview that survives a rebuild serves a page whose scripts all 404
# — which looks exactly like a broken shader. The port must therefore be
# confirmed free before the new server is allowed to claim it.
set -Eeuo pipefail

port="${1:-4321}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

listener() {
  ss -lptnH "sport = :${port}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

if [[ "${HERO_SKIP_BUILD:-0}" != "1" ]]; then
  NEXT_TELEMETRY_DISABLED=1 npm --prefix web run build >/tmp/hero-preview-build.log 2>&1 || {
    tail -30 /tmp/hero-preview-build.log >&2
    exit 1
  }
fi

old="$(listener)"
if [[ -n "$old" ]]; then
  kill -TERM "$old" 2>/dev/null || true
  for _ in $(seq 1 60); do
    [[ -z "$(listener)" ]] && break
    sleep 0.5
  done
  if [[ -n "$(listener)" ]]; then
    kill -KILL "$old" 2>/dev/null || true
    sleep 1
  fi
fi
[[ -z "$(listener)" ]] || {
  echo "port ${port} is still held by PID $(listener)" >&2
  exit 1
}

cd web
nohup setsid ./node_modules/.bin/next start --hostname 127.0.0.1 --port "$port" \
  >/tmp/hero-preview-server.log 2>&1 </dev/null &
disown

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${port}/" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${port}/" >/dev/null

# A served page whose entry chunk 404s still returns 200 for the document, so
# check one real script the document asks for before calling the preview up.
chunk="$(curl -fsS "http://127.0.0.1:${port}/" |
  grep -oP '/_next/static/chunks/[A-Za-z0-9_.-]+\.js' | head -1)"
if [[ -n "$chunk" ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}${chunk}")"
  [[ "$code" == "200" ]] || {
    echo "preview is serving a stale build: ${chunk} -> ${code}" >&2
    exit 1
  }
fi

echo "hero preview ready at http://127.0.0.1:${port}"
