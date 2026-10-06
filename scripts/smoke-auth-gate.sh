#!/usr/bin/env bash
#
# Smoke test for the nginx gate in front of the dashboard's /app shell (spec 028
# FR-006). Run against the prod compose stack (`docker compose --profile prod up -d`):
#
#     bash scripts/smoke-auth-gate.sh                      # http://localhost:8080
#     BASE_URL=https://dev.ai0.global bash scripts/smoke-auth-gate.sh
#     SESSION_COOKIE='<value of tracking_jwt>' bash scripts/smoke-auth-gate.sh
#     STOP_AUTOMATION=1 bash scripts/smoke-auth-gate.sh    # also checks the 503 page
#
# SESSION_COOKIE (optional) is the value of a live `tracking_jwt` cookie, copied
# from the browser's dev tools; it enables the "logged in → 200" checks. It is
# sent only to BASE_URL and never printed.
# STOP_AUTOMATION=1 stops the automation container for a few seconds to check
# that the gate answers 503 (not a redirect to /login), then starts it again.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:${DASHBOARD_PORT:-8080}}"
BASE_URL="${BASE_URL%/}"
fails=0

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }

# status, Location and Cache-Control of one request (no redirects followed).
probe() {
  local path="$1"; shift
  curl -s -o /dev/null -D - --max-time 10 "$@" "${BASE_URL}${path}" | tr -d '\r'
}
status_of()   { awk 'toupper($1) ~ /^HTTP\// { s = $2 } END { print s }'; }
header_of()   { awk -v h="$(echo "$1" | tr '[:upper:]' '[:lower:]')" -F': ' 'tolower($1) == h { v = $2 } END { print v }'; }

expect_status() {
  local name="$1" want="$2" path="$3"; shift 3
  local got; got="$(probe "$path" "$@" | status_of)"
  [ "$got" = "$want" ] && pass "$name ($got)" || fail "$name: want $want, got ${got:-no answer}"
}

echo "auth gate smoke: ${BASE_URL}"

# 1. Without a cookie, /app/* redirects to /login with the original path in `next`.
h="$(probe /app/editor)"
st="$(echo "$h" | status_of)"; loc="$(echo "$h" | header_of location)"
if [ "$st" = "302" ] && [[ "$loc" == /login\?*next=/app/editor ]]; then pass "/app/editor without cookie → 302 $loc"
else fail "/app/editor without cookie: want 302 /login?…next=/app/editor, got $st ${loc:-}"; fi

h="$(probe '/app/agents/@manager?tab=inbox')"
loc="$(echo "$h" | header_of location)"
[[ "$loc" == *"next=/app/agents/@manager?tab=inbox" ]] && pass "deep link keeps path + query in next" \
  || fail "deep link: Location was ${loc:-none}"

expect_status "/app without cookie → 302" 302 /app
expect_status "a dead cookie → 302" 302 /app/editor -H 'Cookie: tracking_jwt=not-a-session'

# 2. Public paths are never gated.
expect_status "/ public" 200 /
expect_status "/login public" 200 /login
expect_status "/report/x public (SPA route)" 200 /report/x
expect_status "/applications is not /app" 200 /applications
asset="$(curl -s --max-time 10 "${BASE_URL}/" | grep -oE '/assets/[^"]+\.js' | head -1)"
if [ -n "$asset" ]; then expect_status "$asset public" 200 "$asset"; else fail "no /assets/*.js found in /"; fi
st="$(probe /auth/me | status_of)"
[ "$st" = "200" ] && pass "/auth/me (API prefix) not gated ($st)" || fail "/auth/me: want 200, got ${st:-no answer}"

# 3. With a live session: the shell, never cached.
if [ -n "${SESSION_COOKIE:-}" ]; then
  h="$(probe /app/editor -H "Cookie: tracking_jwt=${SESSION_COOKIE}")"
  st="$(echo "$h" | status_of)"; cc="$(echo "$h" | header_of cache-control)"
  [ "$st" = "200" ] && [[ "$cc" == *no-store* ]] && pass "/app/editor with cookie → 200, Cache-Control: $cc" \
    || fail "/app/editor with cookie: want 200 + no-store, got $st / ${cc:-no cache-control}"
else
  echo "  skip  logged-in checks (set SESSION_COOKIE)"
fi

# 4. Backend down → the 503 page, not a login loop.
if [ "${STOP_AUTOMATION:-}" = "1" ]; then
  cd "$(dirname "$0")/.." || exit 1
  docker compose --profile prod stop automation >/dev/null
  sleep 2
  expect_status "/app/editor with automation stopped → 503" 503 /app/editor
  docker compose --profile prod start automation >/dev/null
  echo "  automation started again"
else
  echo "  skip  outage check (set STOP_AUTOMATION=1)"
fi

if [ "$fails" -gt 0 ]; then echo "auth gate smoke: $fails failure(s)"; exit 1; fi
echo "auth gate smoke: all passed"
