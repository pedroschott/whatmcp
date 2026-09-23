# Remote access to WhatMCP

By default WhatMCP speaks **stdio**: your AI client spawns it as a subprocess and
nothing listens on a network. That is the most secure configuration and the right
one for Claude Code and Claude Desktop. Everything below is for the cases stdio
cannot serve — an agent framework that only takes a URL, or ChatGPT.

**Understand the trade before you start.** A remote endpoint puts your entire
message history behind a credential. That archive contains messages from everyone
who ever wrote to you, none of whom agreed to it being reachable from the
internet. Losing the token is closer to losing your unlocked phone than to
leaking an API key.

---

The HTTP server uses the same archive configuration as the CLI. For file-based
setup on Windows or macOS, first follow [File import](IMPORT.md). The tunnel
installation and service commands in sections 2 and 3 use macOS tools. The
repository does not include a Windows service installer.

## Which path do you need?

| you want | use | needs |
|---|---|---|
| Claude Code / Desktop | stdio (default) | nothing |
| An agent on the same computer that needs a URL | HTTP on loopback | nothing |
| An agent elsewhere, occasional/testing | quick tunnel | nothing |
| **ChatGPT** | **named tunnel + OAuth** | **a domain you control** |

ChatGPT is the demanding one: it refuses static bearer tokens and requires OAuth
with dynamic client registration, which needs a *stable* issuer URL — so a
rotating quick-tunnel hostname will not work.

---

## 1. HTTP on loopback

```bash
npm run wa -- http-token       # 32 random bytes, stored 0600 in ~/.whatmcp/config.json
npm run serve:http             # http://127.0.0.1:8787/mcp
```

Call it with `Authorization: Bearer <token>`. This also serves the dashboard at
`http://127.0.0.1:8787/`.

## 2. Quick tunnel on macOS

```bash
brew install cloudflared
bash deploy/install.sh
npm run wa -- url              # the current public URL
```

`install.sh` loads two LaunchAgents (server + tunnel), so both survive reboot,
and wraps the server in `caffeinate` so an idle Mac does not take the endpoint
down. Undo it all with `bash deploy/uninstall.sh`.

The hostname is random and **changes on every reconnect**. That is why the Host
allowlist accepts the `.trycloudflare.com` suffix rather than an exact name —
documented as the compromise it is in `src/mcp/http.ts`. Fine for testing;
unusable for OAuth.

## 3. Named tunnel on macOS — stable hostname, required for ChatGPT

You need a domain **on Cloudflare**. On a free plan the whole domain's
nameservers must point at Cloudflare — delegating only a subdomain is an
Enterprise feature. A fresh domain bought for this purpose is the painless case;
moving an active domain means checking that Cloudflare imported your existing
records (especially `MX`, or mail stops arriving) before switching nameservers.

```bash
cloudflared tunnel login
cloudflared tunnel create whatmcp
cloudflared tunnel route dns whatmcp mcp.example.com
bash deploy/use-named-tunnel.sh mcp.example.com
```

The last script pins `public_url` (so the OAuth issuer stops being derived
per-request), **restores exact-hostname matching** on the Host check, repoints
the tunnel agent, and verifies health over the real hostname.

## 4. ChatGPT

Settings → Connectors → **Developer mode** → add `https://mcp.example.com/mcp`,
choose **OAuth**. ChatGPT registers itself, redirects you to `/authorize`, and
you paste your WhatMCP token once to approve. It holds an access token after
that.

```bash
npm run wa -- oauth                    # who holds a live token
npm run wa -- oauth revoke <client_id> # kill every token for one client
```

Revocation needs a server restart to take effect:
`launchctl kickstart -k gui/$(id -u)/com.whatmcp.server`

---

## What protects the endpoint

Six controls, in the order a request meets them.

**1. Host allowlist.** A request whose `Host` header is not on the list is
refused *even with a valid token*. This defeats DNS rebinding, where a page you
visit resolves an attacker's domain to `127.0.0.1` and reads this server through
your browser — a bearer token does not stop that on its own, so the check is
independent of auth.

**2. Origin rejection on `/mcp`.** Any `Origin` header means a browser sent it,
and no legitimate MCP client is a web page.

**3. Bearer token**, compared in constant time, minimum 32 characters, enforced
at boot. The server refuses to start unauthenticated rather than degrading to
open.

**4. Public OAuth abuse controls.** `/authorize` is the one deliberately public
browser surface — ChatGPT redirects *your browser* to it, so it cannot be
loopback-only. It allows 5 free token attempts per IP, then locks that IP out with
exponential backoff capped at 15 minutes. Dynamic client registration is limited
to 10 attempts per IP per hour, bounds names and redirect lists, caps total stored
clients, prunes stale registrations, and never logs raw control characters or
unbounded names. The token is 256 bits, so arithmetic is what makes guessing
infeasible; these limits keep public endpoints cheap to absorb. Attribution is per
real client IP — `trust proxy` is set to loopback so `cloudflared`'s
`X-Forwarded-For` is honoured but nothing else can forge it.

**5. The dashboard is loopback-only, enforced in code.** A tunnel forwards
*everything* on `127.0.0.1:8787`, so the dashboard would otherwise go public the
moment one starts. Its routes require a loopback `Host` header, so the tunnel's
hostname gets a 404 while `/mcp` still serves. Verify any time:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.example.com/   # expect 404
```

**6. OAuth hygiene.** PKCE S256 mandatory (`plain` is not advertised, so no
downgrade), `redirect_uri` matched exactly (prefix matching is how these become
open redirects), codes single-use with a 60-second TTL bound to client, redirect
URI, challenge and resource, refresh tokens rotated on every use, and codes and
tokens stored only as SHA-256 hashes — a leaked `oauth.db` is not a leaked
archive. Consent responses deny framing and caching. OAuth grants are strictly
`whatmcp:read` and do not expose `sync_archive`, which writes locally and calls the
embeddings API.

**Not included: TLS.** This server does not terminate it. That is the tunnel's
job, which is why binding a public interface directly prints a warning instead of
being a supported path.

---

## Troubleshooting

**`failed to dial to edge with quic` / tunnel down but internet fine.**
`cloudflared` needs outbound **port 7844** (TCP and UDP). Restrictive networks —
corporate Wi-Fi, guest networks, cellular tethering — commonly allow only 80/443.
There is no port-443 fallback for the tunnel control plane, so the fix is a
different network. Check with `nc -z -w 5 198.41.200.63 7844`. It reconnects on
its own once the network allows it; nothing needs restarting.

**`ERR_CONNECTION_CLOSED` in your browser, but the endpoint works elsewhere.**
Stale DNS locally. Compare resolvers:

```bash
dig +short NS example.com @1.1.1.1
dig +short NS example.com @8.8.8.8
```

If they disagree, yours is cached. Wait for the TTL, or point your Mac at a
resolver that already has the record.

**Consent page loads, you approve, nothing happens.** Historically caused by
`form-action` in the page's own CSP blocking the post-submit redirect. Fixed, but
if you touch `consent.html`, remember that browsers apply `form-action` to
redirects *following* a form submission — narrowing it silently breaks OAuth with
no error anywhere the user can see.

**`Bootstrap failed: 5: Input/output error`.** launchd raced a still-unloading
job. Wait a second and re-run the `bootstrap`.

**Endpoint disappears when you walk away.** The Mac slept. `caffeinate -is`
covers AC power only; on battery you need `sudo pmset -b sleep 0`.

---

## Turning it off

The uninstall script below removes the macOS services installed by this guide.
For a manually started server, stop its process.

```bash
bash deploy/uninstall.sh                       # stop server + tunnel
npm run wa -- oauth revoke                     # revoke every OAuth grant
npm run wa -- http-token                       # rotate the bearer token
```

The archive is untouched by all three.
