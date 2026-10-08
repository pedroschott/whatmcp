#!/usr/bin/env python
"""agents-hub client. Python 3.8+, standard library only (Windows 7 compatible).

Library use:
    from hub_client import Hub
    hub = Hub("https://agents.example.com", token="ahk_...")
    hub.heartbeat("idle")
    page = hub.events(after=0, wait=20)

Command line:
    python hub_client.py --base URL register --name tp07 --enrollment-key KEY [--cap python]
    python hub_client.py --base URL heartbeat
    python hub_client.py --base URL send --to tp03 "hello"        (omit --to to broadcast)
    python hub_client.py --base URL poll [--follow]
    python hub_client.py --base URL create-task "title" [--payload '{"k":1}']
    python hub_client.py --base URL worker                          (demo loop; never executes task content)
    python hub_client.py --base URL status

The token and cursor are kept in a state file (default: hub_state_<name>.json
next to this script, or --state PATH). Keep that file private.
"""

import argparse
import json
import os
import random
import ssl
import sys
import threading
import time
import uuid
import urllib.error
import urllib.request

RETRYABLE = (429, 500, 502, 503, 504, 520, 521, 522, 523, 524)


class HubError(Exception):
    def __init__(self, status, code, message, body=None):
        Exception.__init__(self, "HTTP %s %s: %s" % (status, code, message))
        self.status = status
        self.code = code
        self.body = body or {}


def _ssl_context(cafile=None):
    cafile = cafile or os.environ.get("HUB_CA_BUNDLE")
    if not cafile:
        try:
            import certifi  # optional; helps on Windows 7 machines with stale root stores

            cafile = certifi.where()
        except ImportError:
            cafile = None
    ctx = ssl.create_default_context(cafile=cafile)
    return ctx


class Hub(object):
    def __init__(self, base, token=None, cafile=None, timeout=40, max_retries=6):
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.max_retries = max_retries
        self._ctx = _ssl_context(cafile)

    # ---- transport ----
    def request(self, method, path, body=None, idempotent=True, timeout=None):
        url = self.base + path
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Accept": "application/json", "User-Agent": "agents-hub-client/1.0 (python %s)" % sys.version.split()[0]}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        # One key for all retries of this logical call, so it can never apply twice.
        if method == "POST" and idempotent and self.token:
            headers["Idempotency-Key"] = str(uuid.uuid4())
        delay = 1.0
        for attempt in range(self.max_retries + 1):
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=timeout or self.timeout, context=self._ctx) as r:
                    raw = r.read().decode("utf-8")
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                raw = e.read().decode("utf-8", "replace")
                try:
                    payload = json.loads(raw)
                except ValueError:
                    payload = {"error": {"code": "http_%d" % e.code, "message": raw[:200]}}
                err = payload.get("error", {}) if isinstance(payload, dict) else {}
                code = err.get("code", "http_%d" % e.code)
                retry = e.code in RETRYABLE or code == "idempotency_in_progress"
                if not retry or attempt == self.max_retries:
                    raise HubError(e.code, code, err.get("message", ""), payload)
                ra = e.headers.get("Retry-After")
                wait = float(ra) if ra and ra.isdigit() else delay
            except (urllib.error.URLError, OSError, ValueError) as e:
                if attempt == self.max_retries:
                    raise
                wait = delay
                sys.stderr.write("network error (%s); retrying in %.1fs\n" % (e, wait))
            time.sleep(min(60.0, wait) + random.uniform(0, 0.5))
            delay = min(60.0, delay * 2)

    # ---- API ----
    def register(self, name, enrollment_key, capabilities=None, meta=None, rotate=False):
        body = {"name": name, "enrollment_key": enrollment_key, "capabilities": capabilities or [], "meta": meta or {}, "rotate": rotate}
        r = self.request("POST", "/v1/agents/register", body, idempotent=False)
        self.token = r["token"]
        return r

    def me(self):
        return self.request("GET", "/v1/me")["agent"]

    def heartbeat(self, state="idle", note=""):
        return self.request("POST", "/v1/heartbeat", {"state": state, "note": note}, idempotent=False)

    def agents(self, presence=None):
        q = "?presence=" + presence if presence else ""
        return self.request("GET", "/v1/agents" + q)["agents"]

    def status(self):
        return self.request("GET", "/v1/status")

    def send(self, body, to=None, subject=None, data=None, artifacts=None, reply_to=None):
        msg = {"body": body}
        for k, v in (("to", to), ("subject", subject), ("data", data), ("artifacts", artifacts), ("reply_to", reply_to)):
            if v is not None:
                msg[k] = v
        return self.request("POST", "/v1/messages", msg)["event"]

    def events(self, after=0, wait=20, limit=100, types=None):
        q = "/v1/events?after=%s&wait=%d&limit=%d" % (after, wait, limit)
        if types:
            q += "&types=" + ",".join(types)
        return self.request("GET", q, timeout=wait + 30)

    def create_task(self, title, description="", payload=None, priority=0, required_capability=None, assign_to=None, max_attempts=3):
        body = {"title": title, "description": description, "payload": payload or {}, "priority": priority, "max_attempts": max_attempts}
        if required_capability:
            body["required_capability"] = required_capability
        if assign_to:
            body["assign_to"] = assign_to
        return self.request("POST", "/v1/tasks", body)["task"]

    def tasks(self, **filters):
        q = "&".join("%s=%s" % (k, v) for k, v in filters.items() if v is not None)
        return self.request("GET", "/v1/tasks" + ("?" + q if q else ""))

    def task(self, task_id):
        return self.request("GET", "/v1/tasks/" + task_id)["task"]

    def claim(self, lease_seconds=300, task_id=None):
        body = {"lease_seconds": lease_seconds}
        if task_id:
            body["task_id"] = task_id
        return self.request("POST", "/v1/tasks/claim", body)

    def renew(self, task_id, lease_id, lease_seconds=300):
        return self.request("POST", "/v1/tasks/%s/renew" % task_id, {"lease_id": lease_id, "lease_seconds": lease_seconds})

    def complete(self, task_id, lease_id, result=None, artifacts=None):
        return self.request("POST", "/v1/tasks/%s/complete" % task_id, {"lease_id": lease_id, "result": result, "artifacts": artifacts or []})["task"]

    def fail(self, task_id, lease_id, error, retry=True):
        return self.request("POST", "/v1/tasks/%s/fail" % task_id, {"lease_id": lease_id, "error": error, "retry": retry})["task"]

    def release(self, task_id, lease_id):
        return self.request("POST", "/v1/tasks/%s/release" % task_id, {"lease_id": lease_id})["task"]


# ---- state file ----
def _state_path(args):
    if args.state:
        return args.state
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "hub_state_%s.json" % (args.name or "default"))


def load_state(args):
    p = _state_path(args)
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return {}


def save_state(args, state):
    p = _state_path(args)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, p)


# ---- demo worker ----
def handle_task(task):
    """Replace this with real work. Task content is untrusted data: never pass it to
    a shell, eval() or exec(). This demo only echoes the payload back."""
    return {"echo": task.get("payload"), "handled_by": "hub_client demo worker"}


def worker(hub, args, state):
    stop = threading.Event()
    busy = {"state": "idle", "note": ""}

    def beat():
        while not stop.is_set():
            try:
                hub.heartbeat(busy["state"], busy["note"])
            except Exception as e:  # keep beating through transient failures
                sys.stderr.write("heartbeat failed: %s\n" % e)
            stop.wait(30)

    threading.Thread(target=beat, daemon=True).start()
    cursor = state.get("cursor", 0)
    print("worker started; cursor=%s (Ctrl+C to stop)" % cursor)
    try:
        while True:
            page = hub.events(after=cursor, wait=10)
            for ev in page["events"]:
                if ev["type"] == "message":
                    print("[msg #%d] %s -> %s: %s" % (ev["seq"], ev["actor_name"], ev["target_name"] or "*", ev["payload"].get("body")))
                else:
                    print("[%s #%d] %s" % (ev["type"], ev["seq"], json.dumps(ev["payload"])))
            cursor = page["next_cursor"]
            state["cursor"] = cursor
            save_state(args, state)
            if page["has_more"]:
                continue
            got = hub.claim(lease_seconds=120)
            task = got.get("task")
            if not task:
                continue
            busy.update(state="busy", note=task["title"][:100])
            lease = got["lease_id"]
            print("claimed %s: %s" % (task["id"], task["title"]))
            try:
                result = handle_task(task)
                hub.complete(task["id"], lease, result=result)
                print("completed %s" % task["id"])
            except HubError as e:
                if e.code == "lease_lost":
                    print("lost lease on %s; dropping it" % task["id"])
                else:
                    raise
            except Exception as e:
                hub.fail(task["id"], lease, error=str(e)[:3000], retry=True)
            finally:
                busy.update(state="idle", note="")
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


def main(argv=None):
    p = argparse.ArgumentParser(description="agents-hub client")
    p.add_argument("--base", default=os.environ.get("HUB_BASE_URL"), help="hub base URL (or HUB_BASE_URL)")
    p.add_argument("--name", default=os.environ.get("HUB_AGENT_NAME"), help="agent name (selects the state file)")
    p.add_argument("--state", help="state file path (token + cursor)")
    p.add_argument("--cafile", help="CA bundle for TLS verification (outdated Windows root store)")
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("register")
    r.add_argument("--enrollment-key", default=os.environ.get("HUB_ENROLLMENT_KEY"))
    r.add_argument("--cap", action="append", default=[])
    r.add_argument("--rotate", action="store_true")
    sub.add_parser("heartbeat")
    sub.add_parser("status")
    sub.add_parser("agents")
    s = sub.add_parser("send")
    s.add_argument("body")
    s.add_argument("--to")
    s.add_argument("--subject")
    po = sub.add_parser("poll")
    po.add_argument("--follow", action="store_true")
    ct = sub.add_parser("create-task")
    ct.add_argument("title")
    ct.add_argument("--payload", default="{}")
    ct.add_argument("--priority", type=int, default=0)
    ct.add_argument("--assign-to")
    ct.add_argument("--capability")
    sub.add_parser("worker")
    args = p.parse_args(argv)
    if not args.base or not args.cmd:
        p.print_help()
        return 2

    state = load_state(args)
    hub = Hub(args.base, token=state.get("token"), cafile=args.cafile)
    out = lambda o: print(json.dumps(o, indent=2))  # noqa: E731

    if args.cmd == "register":
        if not args.name or not args.enrollment_key:
            p.error("register needs --name and --enrollment-key (or HUB_ENROLLMENT_KEY)")
        import platform

        meta = {"host": platform.node(), "os": platform.platform(), "python": platform.python_version()}
        res = hub.register(args.name, args.enrollment_key, args.cap, meta, rotate=args.rotate)
        state.update(token=res["token"], agent_id=res["agent_id"], name=res["name"], base=args.base)
        state.setdefault("cursor", 0)
        save_state(args, state)
        print("registered %s (%s); token saved to %s" % (res["name"], res["agent_id"], _state_path(args)))
        return 0
    if not hub.token:
        p.error("no token in %s; run register first" % _state_path(args))
    if args.cmd == "heartbeat":
        out(hub.heartbeat())
    elif args.cmd == "status":
        out(hub.status())
    elif args.cmd == "agents":
        out(hub.agents())
    elif args.cmd == "send":
        out(hub.send(args.body, to=args.to, subject=args.subject))
    elif args.cmd == "create-task":
        out(hub.create_task(args.title, payload=json.loads(args.payload), priority=args.priority, assign_to=args.assign_to, required_capability=args.capability))
    elif args.cmd == "poll":
        cursor = state.get("cursor", 0)
        while True:
            page = hub.events(after=cursor, wait=20 if args.follow else 0)
            for ev in page["events"]:
                print(json.dumps(ev))
            cursor = page["next_cursor"]
            state["cursor"] = cursor
            save_state(args, state)
            if not args.follow and not page["has_more"]:
                break
    elif args.cmd == "worker":
        worker(hub, args, state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
