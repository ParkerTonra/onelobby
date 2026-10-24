#!/usr/bin/env bash
# Keepalive smoke test for a clean Ubuntu 22.04/24.04 VM after `docker compose up -d`.
#   1. /healthz over TLS answers 200 with a valid certificate
#   2. a TURN allocation works over UDP with credentials minted like keepalive-server does
#   3. the same works over TCP and TLS with UDP to the relay blocked (needs root for iptables)
# Run from anywhere:  sudo deploy/scripts/smoke.sh   (reads deploy/.env)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/../.env}"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE (copy .env.example to .env first)"; exit 2; }
set -a; . "$ENV_FILE"; set +a
: "${LOBBY_DOMAIN:?}" "${TURN_SECRET:?}" "${TURN_EXTERNAL_IP:?}"
TLS_PORT="${TURN_TLS_PORT:-5349}"

fails=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

need() { command -v "$1" >/dev/null 2>&1 || { echo "installing $2"; apt-get install -y -qq "$2" >/dev/null; }; }
if [ "$(id -u)" = 0 ]; then
  apt-get update -qq >/dev/null
  need curl curl; need openssl openssl; need turnutils_uclient coturn; need iptables iptables
fi
for c in curl openssl turnutils_uclient; do
  command -v "$c" >/dev/null || { echo "missing $c (apt install curl openssl coturn)"; exit 2; }
done

# Credentials: same algorithm as the server (DESIGN s.10): user = expiry:peerId, pass = base64(HMAC-SHA1).
USER_NAME="$(( $(date +%s) + 3600 )):smoke"
PASS="$(printf %s "$USER_NAME" | openssl dgst -sha1 -hmac "$TURN_SECRET" -binary | base64)"
# Cross-check against the Node implementation when node is around.
if command -v node >/dev/null; then
  N="$(node "$HERE/turn-creds-check.mjs" mint "$TURN_SECRET" smoke 3600)"
  NP="$(printf %s "$N" | sed -E 's/.*"credential":"([^"]+)".*/\1/')"
  NU="$(printf %s "$N" | sed -E 's/.*"username":"([^"]+)".*/\1/')"
  PASS="$(printf %s "$NU" | openssl dgst -sha1 -hmac "$TURN_SECRET" -binary | base64)"
  [ "$PASS" = "$NP" ] && pass "openssl and node mint the same credential" || fail "credential mismatch openssl vs node"
  USER_NAME="$NU"
fi

# 1. healthz over TLS (no -k: the certificate must be valid)
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$LOBBY_DOMAIN/healthz" 2>&1)"
[ "$code" = "200" ] && pass "https://$LOBBY_DOMAIN/healthz -> 200" || fail "healthz returned: $code"

uclient() { # extra flags...
  timeout 40 turnutils_uclient -n 1 -m 1 -l 20 -e "$TURN_EXTERNAL_IP" -u "$USER_NAME" -w "$PASS" "$@" "$LOBBY_DOMAIN" 2>&1
}
ok_alloc() { ! grep -qiE "error|cannot|unauthorized|failed" <<<"$1" && grep -qiE "allocat|tot_send_msgs|Total" <<<"$1"; }

# 2. UDP allocation
out="$(uclient -p 3478)"
ok_alloc "$out" && pass "TURN allocation over UDP 3478" || { fail "UDP allocation"; echo "$out" | tail -5; }

# 3. TCP and TLS with UDP blocked
if [ "$(id -u)" = 0 ] && command -v iptables >/dev/null; then
  RULES=(-p udp --dport 3478 -j DROP)
  iptables -I OUTPUT "${RULES[@]}"
  trap 'iptables -D OUTPUT "${RULES[@]}" 2>/dev/null' EXIT
  out="$(uclient -p 3478 -t)"
  ok_alloc "$out" && pass "TURN allocation over TCP 3478 (UDP blocked)" || { fail "TCP allocation"; echo "$out" | tail -5; }
  out="$(uclient -p "$TLS_PORT" -t -S)"
  ok_alloc "$out" && pass "TURN allocation over TLS $TLS_PORT (UDP blocked)" || { fail "TLS allocation"; echo "$out" | tail -5; }
else
  echo "skip TCP/TLS with UDP blocked (run as root with iptables)"
fi

[ "$fails" = 0 ] && echo "smoke: all passed" || echo "smoke: $fails failed"
exit "$fails"
