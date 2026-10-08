#!/usr/bin/env python3
"""End-to-end smoke test against a running hub (local or deployed).

    HUB_ENROLLMENT_KEY=... HUB_ADMIN_TOKEN=... HUB_LOGS_KEY=... python3 scripts/smoke_test.py https://agents.example.com [--slow]

Registers two throwaway agents, exchanges messages, races two claims on one task
(exactly one must win), renews, completes, checks idempotent replay and status,
then revokes the two agents (when an admin token is given). Only touches tasks
it created itself, so it is safe to run against a live fleet.
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "client"))
from hub_client import Hub, HubError  # noqa: E402

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8799"
SLOW = "--slow" in sys.argv
ENROLL = os.environ["HUB_ENROLLMENT_KEY"]
ADMIN = os.environ.get("HUB_ADMIN_TOKEN")
RUN = uuid.uuid4().hex[:6]
passed = 0


def check(cond, what):
    global passed
    if not cond:
        raise SystemExit("FAIL: " + what)
    passed += 1
    print("ok  " + what)


def raw(method, path, body=None, token=None, headers=None):
    h = {"Content-Type": "application/json", "User-Agent": "agents-hub-smoke/1.0"}
    if token:
        h["Authorization"] = "Bearer " + token
    h.update(headers or {})
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode()
            return r.status, r.headers, text
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode()


def expect_error(fn, code):
    try:
        fn()
    except HubError as e:
        return e.code == code
    return False


# --- docs ---
st, hd, doc = raw("GET", "/")
check(st == 200 and "agents-hub" in doc and "/v1/tasks/claim" in doc and "lease_lost" in doc, "GET / serves agent documentation")
st, _, spec = raw("GET", "/openapi.json")
check(st == 200 and json.loads(spec)["openapi"].startswith("3."), "GET /openapi.json is valid JSON OpenAPI")
st, _, py = raw("GET", "/client.py")
check(st == 200 and "class Hub" in py, "GET /client.py serves the Python client")

# --- auth ---
st, _, _ = raw("POST", "/v1/messages", {"body": "anon"})
check(st == 401, "unauthenticated posting is rejected (401)")
st, _, _ = raw("POST", "/v1/messages", {"body": "x"}, token="ahk_not_a_real_token")
check(st == 401, "bad token is rejected (401)")
st, _, _ = raw("POST", "/v1/agents/register", {"name": "smoke-x-" + RUN, "enrollment_key": "wrong"})
check(st == 403, "registration with a wrong enrollment key is rejected (403)")

a, b = Hub(BASE), Hub(BASE)
ra = a.register("smoke-a-" + RUN, ENROLL, ["smoke"], {"purpose": "smoke test"})
rb = b.register("smoke-b-" + RUN, ENROLL, ["smoke"], {"purpose": "smoke test"})
check(ra["token"].startswith("ahk_") and rb["agent_id"] != ra["agent_id"], "registered two agents with distinct credentials")
check(expect_error(lambda: Hub(BASE).register("smoke-a-" + RUN, ENROLL), "name_taken"), "duplicate name is rejected (409 name_taken)")

# --- presence ---
hb = a.heartbeat("idle", "smoke")
b.heartbeat("idle")
cursor_b = 0
roster = {x["name"]: x for x in a.agents()}
check(roster["smoke-a-" + RUN]["presence"] == "online" and roster["smoke-b-" + RUN]["presence"] == "online", "both agents online")
start_cursor = hb["latest_cursor"]

# --- messages ---
dm = a.send("hello b " + RUN, to="smoke-b-" + RUN, subject="smoke")
bc = a.send("broadcast " + RUN)
page = b.events(after=start_cursor, wait=0)
bodies = [e["payload"].get("body") for e in page["events"] if e["type"] == "message"]
check("hello b " + RUN in bodies and "broadcast " + RUN in bodies, "B received direct + broadcast message via cursor polling")
page2 = b.events(after=page["next_cursor"], wait=0)
check(all(e["seq"] > page["next_cursor"] for e in page2["events"]), "cursor advances (no replay after next_cursor)")
st, _, _ = raw("POST", "/v1/messages", {"body": "x" * 9000}, token=a.token)
check(st == 413, "oversized message rejected (413)")

# --- tasks: exactly-once claim ---
task = a.create_task("smoke task " + RUN, payload={"n": 1}, required_capability="smoke")
results = {}


def try_claim(name, hub):
    try:
        results[name] = hub.claim(lease_seconds=60, task_id=task["id"])
    except HubError as e:
        results[name] = e.code


ts = [threading.Thread(target=try_claim, args=(n, h)) for n, h in (("a", a), ("b", b))]
[t.start() for t in ts]
[t.join() for t in ts]
winners = [n for n, r in results.items() if isinstance(r, dict) and r.get("task")]
check(len(winners) == 1 and "not_claimable" in results.values(), "concurrent claim: exactly one winner, loser gets 409 not_claimable")
w = a if winners[0] == "a" else b
loser = b if w is a else a
claim = results[winners[0]]
lease = claim["lease_id"]
check(claim["task"]["attempts"] == 1 and claim["task"]["lease_id"] == lease, "winner holds the lease (attempt 1)")
check(expect_error(lambda: loser.complete(task["id"], "lse_bogus"), "lease_lost"), "non-holder cannot complete (409 lease_lost)")
check("lease_id" not in loser.task(task["id"]), "lease_id hidden from non-holders")

r = w.renew(task["id"], lease, 120)
check(r["lease_expires_in_s"] == 120, "lease renewed")

key = "smoke-complete-" + RUN
body = {"lease_id": lease, "result": {"ok": True}, "artifacts": [{"name": "out.txt", "uri": "https://example.com/out.txt"}]}
st1, h1, t1 = raw("POST", "/v1/tasks/%s/complete" % task["id"], body, token=w.token, headers={"Idempotency-Key": key})
st2, h2, t2 = raw("POST", "/v1/tasks/%s/complete" % task["id"], body, token=w.token, headers={"Idempotency-Key": key})
check(st1 == 200 and json.loads(t1)["task"]["status"] == "done", "task completed")
check(st2 == 200 and h2.get("Idempotent-Replay") == "true" and t1 == t2, "idempotent retry replays the original response")
st3, _, t3 = raw("POST", "/v1/tasks/%s/complete" % task["id"], body, token=w.token, headers={"Idempotency-Key": key + "-new"})
check(st3 == 409 and json.loads(t3)["error"]["code"] == "lease_lost", "second completion with a new key is refused (409 lease_lost)")
st4, _, _ = raw("POST", "/v1/tasks/%s/complete" % task["id"], {"lease_id": "different"}, token=w.token, headers={"Idempotency-Key": key})
check(st4 == 422, "same Idempotency-Key with a different body is refused (422)")
check(a.claim(task_id=task["id"]) is None if False else expect_error(lambda: a.claim(task_id=task["id"]), "not_claimable"), "done task cannot be claimed again")

# --- release + fail paths ---
t2 = b.create_task("smoke retry " + RUN, required_capability="smoke", max_attempts=2)
c = a.claim(task_id=t2["id"])
rel = a.release(t2["id"], c["lease_id"])
check(rel["status"] == "open" and rel["attempts"] == 0, "release re-opens without consuming an attempt")
c = b.claim(task_id=t2["id"])
f = b.fail(t2["id"], c["lease_id"], "simulated failure", retry=False)
check(f["status"] == "failed", "fail(retry=false) ends the task as failed")

# --- lease expiry (slow) ---
if SLOW and ADMIN:
    t3 = a.create_task("smoke expiry " + RUN, required_capability="smoke")
    c = a.claim(task_id=t3["id"], lease_seconds=30)
    time.sleep(32)
    raw("POST", "/v1/admin/sweep", {}, token=ADMIN)
    check(a.task(t3["id"])["status"] == "open", "expired lease is re-opened by the sweep")
    check(expect_error(lambda: a.renew(t3["id"], c["lease_id"]), "lease_lost"), "renew after expiry+sweep returns lease_lost")
    b.claim(task_id=t3["id"])
    a.request("POST", "/v1/tasks/%s/cancel" % t3["id"], {"reason": "smoke cleanup"})

# --- status ---
s = a.status()
check(s["agents"]["online"] >= 2 and s["tasks"]["done"] >= 1 and s["events"]["latest_cursor"] > start_cursor, "cluster status reflects agents, done task and events")
done = [e for e in a.events(after=start_cursor, wait=0, limit=500)["events"] if e["type"] == "task.completed" and e["payload"]["task_id"] == task["id"]]
check(len(done) == 1, "exactly one task.completed event for the task")

# --- operator logs ---
LOGS = os.environ.get("HUB_LOGS_KEY")
if LOGS:
    st, _, t = raw("GET", "/v1/logs?order=desc&limit=200&key=" + LOGS)
    check(st == 200 and "hello b " + RUN in t, "GET /v1/logs (logs key) shows the full log incl. direct messages")
    st, _, t = raw("GET", "/v1/logs/requests?format=text&order=desc&limit=200", token=LOGS)
    check(st == 200 and "/v1/tasks/claim" in t, "GET /v1/logs/requests shows the request audit log")
    st, _, _ = raw("GET", "/v1/logs", token=a.token)
    check(st == 403, "agent tokens cannot read operator logs (403)")

# --- cleanup ---
if ADMIN:
    for n in ("smoke-a-" + RUN, "smoke-b-" + RUN):
        st, _, _ = raw("POST", "/v1/admin/agents/%s/revoke" % n, {}, token=ADMIN)
        check(st == 200, "revoked " + n)
    st, _, _ = raw("GET", "/v1/me", token=a.token)
    check(st == 401, "revoked token no longer works")

print("\nPASS: %d checks against %s" % (passed, BASE))
