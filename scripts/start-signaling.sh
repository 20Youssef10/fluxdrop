#!/usr/bin/env bash
# FluxDrop — signaling topology launcher (v5-e17 federation ready).
#
# Starts two detached signaling instances so the deployed preview has both
# a canonical server (what the app connects to by default) and a live
# federation partner (what `ROOM@beta` joins route to):
#
#   alpha :3003  — canonical instance; frontend resolves signaling via the
#                  gateway as /?XTransformPort=3003 (see src/lib/fluxdrop/signaling.ts)
#   beta  :3014  — federation partner; advertised to clients through /region
#
# Federation peers authenticate each other with the shared HMAC secret
# `fedsharedsecret1` (same secret the v5-e17 conformance E2E uses).
# The admin dashboard is enabled on alpha with the documented dev token.
#
# Usage:   bash scripts/start-signaling.sh        (idempotent — restarts both)
#          wired into `bun run dev` / `bun run start` so every app (re)start
#          brings the signaling topology back up automatically.
# Logs:    /tmp/fluxdrop-signaling-alpha.log, /tmp/fluxdrop-signaling-beta.log
#
# MUST NEVER FAIL THE CALLER: every dev/start run funnels through here, so
# the script is defensive by contract — no set -u, no set -e, always exit 0.
cd "$(dirname "$0")/../mini-services/signaling" 2>/dev/null || exit 0
[ -f package.json ] || exit 0

FED_SECRET='fedsharedsecret1'
ADMIN_TOKEN="${ADMIN_TOKEN:-changeme-dev}"

# Idempotent: stop any previous instance holding the ports.
for p in $(ss -tlnp 2>/dev/null | grep -E ':(3003|3014) ' | grep -oP 'pid=\K[0-9]+' | sort -u); do
  kill -9 "$p" 2>/dev/null
done
sleep 0.5

SIGNALING_PORT=3003 LOG_LEVEL="${LOG_LEVEL:-info}" FEDERATION_ID=alpha ADMIN_TOKEN="$ADMIN_TOKEN" \
  FEDERATION_PEERS="[{\"id\":\"beta\",\"url\":\"http://localhost:3014\",\"secret\":\"$FED_SECRET\"}]" \
  setsid nohup bun run start >/tmp/fluxdrop-signaling-alpha.log 2>&1 &

SIGNALING_PORT=3014 LOG_LEVEL="${LOG_LEVEL:-info}" FEDERATION_ID=beta \
  FEDERATION_PEERS="[{\"id\":\"alpha\",\"url\":\"http://localhost:3003\",\"secret\":\"$FED_SECRET\"}]" \
  setsid nohup bun run start >/tmp/fluxdrop-signaling-beta.log 2>&1 &

echo "signaling: alpha -> :3003, beta -> :3014 (logs in /tmp/fluxdrop-signaling-*.log)"
exit 0
