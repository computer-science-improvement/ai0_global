#!/usr/bin/env bash
#
# From a laptop: take a server snapshot (scripts/server-snapshot.sh — logs, errors, status, health, migrations,
# agents' state, AI spend; tokens masked) and download it to tmp/server/<stamp>/, unpacked. The local copy of
# server-snapshot.sh is streamed over ssh, so the server does not need this branch checked out.
#
#     bash scripts/pull-server-snapshot.sh                 # dev-stage, last 24 hours
#     bash scripts/pull-server-snapshot.sh 6               # last 6 hours
#     bash scripts/pull-server-snapshot.sh 48 --full       # + agent history export (runs, chats, posts, …)
#     AI0_SSH=root@1.2.3.4 bash scripts/pull-server-snapshot.sh   # another server (prod)
#
# Settings (env):
#   AI0_SSH       user@host            default: root@dev.ai0.global
#   AI0_SSH_KEY   private key          default: ~/.ssh/ai0_dev_deploy when it exists, else ssh's own default
#   AI0_DIR       repo on the server   default: /opt/ai0_global
#   AI0_KEEP=1    keep the archive on the server (default: deleted after download)
#
set -euo pipefail
cd "$(dirname "$0")/.."

HOURS="${1:-24}"
FULL="${2:-}"
[[ "$HOURS" =~ ^[0-9]+$ ]] || { echo "usage: $0 [hours] [--full]" >&2; exit 2; }
SSH_TARGET="${AI0_SSH:-root@dev.ai0.global}"
DIR="${AI0_DIR:-/opt/ai0_global}"
KEY="${AI0_SSH_KEY:-}"
[ -z "$KEY" ] && [ -f "$HOME/.ssh/ai0_dev_deploy" ] && KEY="$HOME/.ssh/ai0_dev_deploy"
SSH_OPTS=(-o ConnectTimeout=15 -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY" -o IdentitiesOnly=yes)

echo "→ $SSH_TARGET:$DIR  (last $HOURS h${FULL:+, full})"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cd '$DIR' && bash -s -- '$HOURS' '$FULL'" < scripts/server-snapshot.sh | tee "$LOG"

REMOTE="$(sed -n 's/^snapshot: done → \(tmp\/server-snapshot-[^ ]*\.tar\.gz\).*/\1/p' "$LOG" | tail -1)"
[ -n "$REMOTE" ] || { echo "no archive reported by the server (see the output above)" >&2; exit 1; }

mkdir -p tmp/server
scp "${SSH_OPTS[@]}" -q "$SSH_TARGET:$DIR/$REMOTE" tmp/server/
[ "${AI0_KEEP:-}" = "1" ] || ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "rm -f '$DIR/$REMOTE'"

ARCHIVE="tmp/server/$(basename "$REMOTE")"
tar -xzf "$ARCHIVE" -C tmp/server
OUT="${ARCHIVE%.tar.gz}"
for f in "$OUT"/*.tar.gz; do [ -f "$f" ] && tar -xzf "$f" -C "$OUT"; done
echo
echo "✓ $OUT"
echo "  status.txt      containers, restarts, revision, disk"
echo "  errors-top.txt  most frequent error shapes   ·   errors.log  every error line"
echo "  logs/           full log per service         ·   db/         runs, slots, drafts, spend"
