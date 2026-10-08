#!/usr/bin/env python3
"""Tiny DNS helper for the whatmcp.site zone using the cloudflared login token
(~/.cloudflared/cert.pem, scoped to tunnels + DNS of that zone). Never prints the token.

    python3 scripts/cf_dns.py show agents.whatmcp.site
    python3 scripts/cf_dns.py delete agents.whatmcp.site
"""
import base64, json, os, re, sys, urllib.request

pem = open(os.path.expanduser("~/.cloudflared/cert.pem")).read()
cert = json.loads(base64.b64decode("".join(re.search(r"-----BEGIN [A-Z ]+-----(.*?)-----END", pem, re.S).group(1).split())))
API = "https://api.cloudflare.com/client/v4/zones/%s/dns_records" % cert["zoneID"]


def call(method, url):
    req = urllib.request.Request(url, method=method, headers={"Authorization": "Bearer " + cert["apiToken"]})
    return json.load(urllib.request.urlopen(req))


op, name = sys.argv[1], sys.argv[2]
recs = call("GET", API + "?name=" + name)["result"]
for r in recs:
    print(op, r["type"], r["name"], "->", r["content"], "proxied" if r.get("proxied") else "")
    if op == "delete":
        call("DELETE", API + "/" + r["id"])
if not recs:
    print("no records for", name)
