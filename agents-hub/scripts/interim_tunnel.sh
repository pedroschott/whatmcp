#!/usr/bin/env bash
# Interim hosting, used only while Workers deploy credentials are unavailable:
# runs the same Worker (workerd via `wrangler dev`, D1 persisted on disk) on this
# Mac and publishes it as agents.whatmcp.site through a named Cloudflare Tunnel,
# the same way the other whatmcp.site hostnames are served. Retired by
# scripts/deploy_workers.sh.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
HOME_="$HOME/.agents-hub"
APP="$HOME_/app"
PORT=8795
HOST_=agents.whatmcp.site
CLOUDFLARED="$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)"
NODE_BIN="$(dirname "$(command -v node)")"
umask 077
mkdir -p "$APP" "$HOME_/logs"
rsync -a --delete --exclude .wrangler --exclude .dev.vars --exclude 'client/hub_state_*' "$SRC/" "$APP/"
[ -f "$HOME_/secrets.env" ] || printf 'ENROLLMENT_KEY=%s\nADMIN_TOKEN=%s\nLOGS_KEY=%s\n' "enr_$(openssl rand -hex 20)" "adm_$(openssl rand -hex 32)" "logs_$(openssl rand -hex 20)" > "$HOME_/secrets.env"
{ cat "$HOME_/secrets.env"; echo "PUBLIC_BASE_URL=https://$HOST_"; } > "$APP/.dev.vars"
(cd "$APP" && npx wrangler d1 migrations apply agents-hub --local)

# tunnel + DNS (cloudflared's cert.pem is scoped to tunnels/DNS of whatmcp.site)
"$CLOUDFLARED" tunnel info agents-hub >/dev/null 2>&1 || "$CLOUDFLARED" tunnel create agents-hub
TID="$("$CLOUDFLARED" tunnel list -o json | python3 -c 'import json,sys; print(next(t["id"] for t in json.load(sys.stdin) if t["name"]=="agents-hub"))')"
cat > "$HOME/.cloudflared/agents-hub.yml" <<YML
tunnel: $TID
credentials-file: $HOME/.cloudflared/$TID.json
protocol: http2
ingress:
  # wrangler dev serves local-only tooling under /cdn-cgi/; never expose it
  - hostname: $HOST_
    path: ^/cdn-cgi/
    service: http_status:404
  - hostname: $HOST_
    service: http://127.0.0.1:$PORT
  - service: http_status:404
YML
"$CLOUDFLARED" tunnel route dns agents-hub "$HOST_" || true

plist() { # label, program args (xml), workdir
  cat > "$HOME/Library/LaunchAgents/$1.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  <key>WorkingDirectory</key><string>$3</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>WRANGLER_SEND_METRICS</key><string>false</string>
    <key>CI</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME_/logs/$1.log</string>
  <key>StandardErrorPath</key><string>$HOME_/logs/$1.log</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  for _ in $(seq 1 20); do launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1 || break; sleep 0.5; done
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$1.plist"
}
s() { printf '<string>%s</string>' "$@"; }
plist com.agentshub.server "$(s "$APP/node_modules/.bin/wrangler" dev --local --ip 127.0.0.1 --port $PORT --show-interactive-dev-session=false --log-level warn)" "$APP"
# a sleeping Mac takes the hub offline; keep it awake (on AC) while it hosts it
plist com.agentshub.caffeinate "$(s /usr/bin/caffeinate -i -s)" "$HOME_"
plist com.agentshub.tunnel "$(s "$CLOUDFLARED" tunnel --no-autoupdate --config "$HOME/.cloudflared/agents-hub.yml" run agents-hub)" "$HOME_"

for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null && break; sleep 1; done
for i in $(seq 1 60); do curl -sf "https://$HOST_/v1/health" >/dev/null && break; sleep 2; done
curl -sf "https://$HOST_/v1/health"
