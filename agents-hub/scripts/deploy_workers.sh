#!/usr/bin/env bash
# Deploy agents-hub to Cloudflare Workers + D1 on agents.whatmcp.site.
# Idempotent: safe to re-run. Requires `npx wrangler login` (or CLOUDFLARE_API_TOKEN
# with Workers Scripts, Workers Routes, D1 and zone DNS edit on whatmcp.site).
#
# If the interim tunnel deployment (scripts/interim_tunnel.sh) is running, its
# data is copied into D1 and the tunnel is retired, so agent tokens keep working.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
HOSTNAME_="agents.whatmcp.site"
SECRETS="${AGENTS_HUB_SECRETS:-$HOME/.agents-hub/secrets.env}"
WR="npx wrangler"

$WR whoami | grep -q "associated with the email" || { echo "not logged in: run 'npx wrangler login' first" >&2; exit 1; }
[ -f "$SECRETS" ] || { echo "missing $SECRETS (ENROLLMENT_KEY=..., ADMIN_TOKEN=..., LOGS_KEY=...)" >&2; exit 1; }

# 1. D1 database
DB_ID="$($WR d1 list --json | python3 -c 'import json,sys; print(next((d["uuid"] for d in json.load(sys.stdin) if d["name"]=="agents-hub"), ""))')"
if [ -z "$DB_ID" ]; then
  $WR d1 create agents-hub
  DB_ID="$($WR d1 list --json | python3 -c 'import json,sys; print(next(d["uuid"] for d in json.load(sys.stdin) if d["name"]=="agents-hub"))')"
fi
sed -i.bak -E "s/\"database_id\": \"[0-9a-f-]+\"/\"database_id\": \"$DB_ID\"/" wrangler.jsonc && rm -f wrangler.jsonc.bak
echo "D1 agents-hub = $DB_ID"
$WR d1 migrations apply agents-hub --remote

# 2. carry over interim data (agents, tasks, events), if any
INTERIM_APP="$HOME/.agents-hub/app"
if [ -d "$INTERIM_APP/.wrangler/state/v3/d1" ] && [ "${SKIP_DATA_COPY:-0}" != 1 ]; then
  EXPORT="$(mktemp -t agents-hub-export).sql"
  (cd "$INTERIM_APP" && $WR d1 export agents-hub --local --no-schema --output "$EXPORT")
  grep -v -E '^INSERT INTO "?(d1_migrations|_cf_KV|_cf_METADATA|sqlite_sequence)"?' "$EXPORT" > "$EXPORT.data" || true
  if [ -s "$EXPORT.data" ]; then $WR d1 execute agents-hub --remote -y --file "$EXPORT.data"; fi
  # keep the event cursor monotonic for agents that saved one
  MAXSEQ="$(grep -oE '^INSERT INTO "?sqlite_sequence"? .*events.*' "$EXPORT" | grep -oE '[0-9]+\)' | tr -d ')' | tail -1)"
  [ -n "$MAXSEQ" ] && $WR d1 execute agents-hub --remote -y --command \
    "UPDATE sqlite_sequence SET seq = MAX(seq, $MAXSEQ) WHERE name = 'events'" || true
  rm -f "$EXPORT" "$EXPORT.data"
fi

# 3. secrets (values never printed)
set -a; . "$SECRETS"; set +a
printf '%s' "$ENROLLMENT_KEY" | $WR secret put ENROLLMENT_KEY
printf '%s' "$ADMIN_TOKEN" | $WR secret put ADMIN_TOKEN
printf '%s' "$LOGS_KEY" | $WR secret put LOGS_KEY

# 4. the hostname must not still point at the interim tunnel
if dig +short CNAME "$HOSTNAME_" @angelina.ns.cloudflare.com | grep -q cfargotunnel.com; then
  python3 scripts/cf_dns.py delete "$HOSTNAME_"
fi

# 5. deploy (creates the custom domain + certificate)
$WR deploy

# 6. retire the interim tunnel
for l in com.agentshub.tunnel com.agentshub.server com.agentshub.caffeinate; do
  launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$l.plist"
done
cloudflared tunnel delete -f agents-hub 2>/dev/null || true

# 7. verify
for i in $(seq 1 30); do curl -sf "https://$HOSTNAME_/v1/health" >/dev/null && break; sleep 5; done
HUB_ENROLLMENT_KEY="$ENROLLMENT_KEY" HUB_ADMIN_TOKEN="$ADMIN_TOKEN" HUB_LOGS_KEY="$LOGS_KEY" python3 scripts/smoke_test.py "https://$HOSTNAME_"
