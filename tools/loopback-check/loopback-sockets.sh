#!/usr/bin/env bash
# Runs a command that is a loopback test run (one process or a script that starts several) and fails when any process of it
# holds a TCP or UDP socket whose local address is not 127.0.0.0/8 or ::1. A socket on 0.0.0.0, [::] or a LAN address is what makes
# Windows ask the player to allow the program, so a loopback run must open none. Linux only (needs `ss` and `ps`).
#   usage: loopback-sockets.sh [--known-gap "<why>"] <name> -- <command> [args...]
#     --known-gap  the stack under test cannot bind loopback only (say why): the offending rows are printed as a warning and do not
#                  fail the run; when a later run has none, a notice says to drop the flag.
#   exit code: the command's own (nonzero stays nonzero); 1 for a non-loopback socket (not a known gap); 1 when ss saw no socket at all
#   (the check would be blind: a run with no TCP or UDP socket is not a networked run).
# Every 0.1 s it lists `ss -H -tunap` rows of the command's process tree. A socket that lives less than that is not seen; the
# WebRTC sockets of a session live as long as the session.
set -uo pipefail
GAP=""
if [ "${1:-}" = "--known-gap" ]; then GAP="${2:?--known-gap needs a reason}"; shift 2; fi
NAME="${1:?usage: loopback-sockets.sh [--known-gap why] <name> -- command...}"; shift
[ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || { echo "loopback-check $NAME: no command given" >&2; exit 2; }
command -v ss > /dev/null || { echo "loopback-check $NAME: ss is not installed" >&2; exit 2; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# the pids of $1 and everything below it
tree() { ps -e -o pid=,ppid= | awk -v root="$1" '{ kid[$2] = kid[$2] " " $1 } END { n = split(root, q, " "); for (i = 1; i <= n; i++) { print q[i]; m = split(kid[q[i]], c, " "); for (j = 1; j <= m; j++) q[++n] = c[j] } }'; }

"$@" &
CMD=$!
: > "$WORK/rows"
while kill -0 "$CMD" 2> /dev/null; do
  tree "$CMD" > "$WORK/pids"
  ss -H -tunap 2> /dev/null | awk -v pf="$WORK/pids" '
    BEGIN { while ((getline p < pf) > 0) pid[p] = 1 }
    { if (match($0, /pid=[0-9]+/)) { id = substr($0, RSTART + 4, RLENGTH - 4); if (id in pid) print $1, $2, $5, $6, $NF } }' >> "$WORK/rows"
  sleep 0.1
done
wait "$CMD"; RC=$?

# distinct rows; the local address's host part decides ("*" and 0.0.0.0 and [::] are every interface)
sort -u "$WORK/rows" > "$WORK/uniq"
TOTAL=$(wc -l < "$WORK/uniq")
awk '{ a = $3; sub(/:[0-9*]+$/, "", a); gsub(/^\[|\]$/, "", a); sub(/%.*/, "", a); sub(/^::ffff:/, "", a)
       if (a ~ /^127\./ || a == "::1") next; print }' "$WORK/uniq" > "$WORK/bad"
BAD=$(wc -l < "$WORK/bad")
echo "loopback-check $NAME: $TOTAL distinct sockets seen in the process tree, $BAD not on loopback (command exit $RC)"
if [ "$BAD" -gt 0 ]; then
  echo "  netid state local peer process"; sed 's/^/  /' "$WORK/bad"
fi
if [ "$TOTAL" -eq 0 ]; then echo "::error::loopback-check $NAME saw no socket of the run: the check is blind"; [ "$RC" -eq 0 ] && RC=1; fi
if [ "$BAD" -gt 0 ]; then
  if [ -n "$GAP" ]; then echo "::warning::loopback-check KNOWN GAP $NAME: $BAD socket(s) not on loopback. $GAP"
  else echo "::error::loopback-check $NAME: $BAD socket(s) not on loopback (a loopback run must bind 127.0.0.1 or ::1 only)"; [ "$RC" -eq 0 ] && RC=1; fi
elif [ -n "$GAP" ]; then
  echo "::notice::loopback-check $NAME: no socket off loopback any more; drop --known-gap"
fi
exit "$RC"
