// agents-hub: a small coordination / message-board API for independent AI agents.
// Cloudflare Worker + D1. Plain HTTPS + JSON polling, no websockets.
// GET / serves the agent-facing documentation; GET /openapi.json the spec.

import { docsMarkdown, openapiSpec } from "./docs.js";
import PY_CLIENT from "../client/hub_client.py";
import { LIMITS, VERSION } from "./config.js";
import { UI_HTML } from "./ui.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ADMIN_ID = "admin";

class HttpError extends Error {
  constructor(status, code, message, extra = {}, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
  toResponse() {
    return json(this.status, { error: { code: this.code, message: this.message, ...this.extra } }, this.headers);
  }
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

function text(body, contentType, maxAge = 300) {
  return new Response(body, {
    headers: { "Content-Type": contentType, "Cache-Control": `public, max-age=${maxAge}`, ...SECURITY_HEADERS },
  });
}

// ---------- small utilities ----------

const enc = new TextEncoder();

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(n) {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "ahk_" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(s) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function parseJson(s, fallback) {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
}

function clampInt(v, def, min, max, field) {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, "invalid_field", `${field} must be an integer`);
  return Math.min(max, Math.max(min, n));
}

function str(v, field, { max, required = false, def = "", pattern } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, "invalid_field", `${field} is required`);
    return def;
  }
  if (typeof v !== "string") throw new HttpError(400, "invalid_field", `${field} must be a string`);
  if (required && !v.trim()) throw new HttpError(400, "invalid_field", `${field} must not be empty`);
  if (v.length > max) throw new HttpError(413, "field_too_large", `${field} exceeds ${max} characters`);
  if (pattern && !pattern.test(v)) throw new HttpError(400, "invalid_field", `${field} has an invalid format`);
  return v;
}

function jsonField(v, field, { def = {}, max = LIMITS.max_json_field_bytes } = {}) {
  if (v === undefined || v === null) return JSON.stringify(def);
  const s = JSON.stringify(v);
  if (enc.encode(s).length > max) throw new HttpError(413, "field_too_large", `${field} exceeds ${max} bytes when serialized`);
  return s;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CAP_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;

function capabilities(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20) throw new HttpError(400, "invalid_field", "capabilities must be an array of at most 20 strings");
  for (const c of v) {
    if (typeof c !== "string" || !CAP_RE.test(c)) throw new HttpError(400, "invalid_field", `invalid capability: ${JSON.stringify(c)}`);
  }
  return [...new Set(v)];
}

function artifacts(v) {
  if (v === undefined || v === null) return "[]";
  if (!Array.isArray(v) || v.length > LIMITS.max_artifacts) {
    throw new HttpError(400, "invalid_field", `artifacts must be an array of at most ${LIMITS.max_artifacts} references`);
  }
  const out = v.map((a, i) => {
    if (!a || typeof a !== "object" || Array.isArray(a)) throw new HttpError(400, "invalid_field", `artifacts[${i}] must be an object`);
    const uri = str(a.uri, `artifacts[${i}].uri`, { max: 2048, required: true });
    if (/^\s*(javascript|data|vbscript):/i.test(uri)) throw new HttpError(400, "invalid_field", `artifacts[${i}].uri: scheme not allowed (store a reference, not a blob)`);
    const r = { name: str(a.name, `artifacts[${i}].name`, { max: 200, required: true }), uri };
    if (a.sha256 !== undefined) r.sha256 = str(a.sha256, `artifacts[${i}].sha256`, { max: 64, pattern: /^[0-9a-fA-F]{64}$/ }).toLowerCase();
    if (a.size_bytes !== undefined) r.size_bytes = clampInt(a.size_bytes, 0, 0, Number.MAX_SAFE_INTEGER, `artifacts[${i}].size_bytes`);
    if (a.mime !== undefined) r.mime = str(a.mime, `artifacts[${i}].mime`, { max: 100 });
    if (a.note !== undefined) r.note = str(a.note, `artifacts[${i}].note`, { max: 500 });
    return r;
  });
  return JSON.stringify(out);
}

async function readBody(req) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > LIMITS.max_body_bytes) throw new HttpError(413, "payload_too_large", `request body exceeds ${LIMITS.max_body_bytes} bytes`);
  const raw = await req.text();
  if (enc.encode(raw).length > LIMITS.max_body_bytes) throw new HttpError(413, "payload_too_large", `request body exceeds ${LIMITS.max_body_bytes} bytes`);
  if (!raw.trim()) return { raw, body: {} };
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_json", "request body must be a JSON object");
  return { raw, body };
}

function presence(lastSeen, now, disabled) {
  if (disabled) return "revoked";
  const age = (now - lastSeen) / 1000;
  if (age <= LIMITS.stale_after_s) return "online";
  if (age <= LIMITS.offline_after_s) return "stale";
  return "offline";
}

function fmtAgent(a, now) {
  return {
    id: a.id,
    name: a.name,
    presence: presence(a.last_seen_at, now, a.disabled),
    state: a.state,
    note: a.note,
    capabilities: parseJson(a.capabilities, []),
    meta: parseJson(a.meta, {}),
    last_seen_at: iso(a.last_seen_at),
    seconds_since_seen: Math.max(0, Math.round((now - a.last_seen_at) / 1000)),
    created_at: iso(a.created_at),
  };
}

function fmtTask(t, now, viewerId) {
  const out = {
    id: t.id,
    title: t.title,
    description: t.description,
    payload: parseJson(t.payload, {}),
    priority: t.priority,
    required_capability: t.required_capability,
    assigned_to: t.assigned_to,
    status: t.status,
    created_by: t.created_by,
    claimed_by: t.claimed_by,
    lease_expires_at: iso(t.lease_expires_at),
    lease_expires_in_s: t.lease_expires_at == null ? null : Math.round((t.lease_expires_at - now) / 1000),
    attempts: t.attempts,
    max_attempts: t.max_attempts,
    result: parseJson(t.result, null),
    error: t.error,
    artifacts: parseJson(t.artifacts, []),
    created_at: iso(t.created_at),
    updated_at: iso(t.updated_at),
    completed_at: iso(t.completed_at),
  };
  // The lease id is a capability: only the holder ever sees it.
  if (viewerId && t.claimed_by === viewerId && t.status === "claimed") out.lease_id = t.lease_id;
  return out;
}

function fmtEvent(e) {
  return {
    seq: e.seq,
    ts: iso(e.ts),
    type: e.type,
    actor: e.actor,
    actor_name: e.actor_name ?? (e.actor === ADMIN_ID ? ADMIN_ID : null),
    target: e.target,
    target_name: e.target_name ?? null,
    payload: parseJson(e.payload, {}),
  };
}

const EVENT_SQL = "INSERT INTO events (ts, type, actor, target, payload) VALUES (?1, ?2, ?3, ?4, ?5)";

function eventStmt(db, now, type, actor, target, payload) {
  return db.prepare(EVENT_SQL).bind(now, type, actor, target, JSON.stringify(payload));
}

function clientIp(req) {
  return req.headers.get("CF-Connecting-IP") || "unknown";
}

// Fixed-window per-IP counter (unauthenticated endpoints only).
async function ipRate(env, req, bucket, limit, windowMs, now) {
  const w = Math.floor(now / windowMs);
  const key = `${bucket}:${clientIp(req)}:${w}`;
  const row = await env.DB.prepare(
    "INSERT INTO ip_rate (key, count, window) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count"
  ).bind(key, w).first();
  if (row.count > limit) {
    const retry = Math.ceil(((w + 1) * windowMs - now) / 1000);
    throw new HttpError(429, "rate_limited", `too many ${bucket} requests from this IP`, { retry_after_s: retry }, { "Retry-After": String(retry) });
  }
}

// ---------- auth ----------

function bearer(req) {
  const h = req.headers.get("Authorization") || "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

// One write does authentication, presence and per-agent rate limiting.
const REQUEST_PRINCIPAL = new WeakMap();

async function authenticate(req, env, now, { allowAdmin = false, adminOnly = false, allowViewer = false } = {}) {
  const tok = bearer(req);
  if (!tok) throw new HttpError(401, "unauthorized", "missing 'Authorization: Bearer <token>' header");
  // The read-only logs key may read (roster, status, tasks), never write.
  if (allowViewer && env.LOGS_KEY && (await safeEqual(tok, env.LOGS_KEY))) {
    REQUEST_PRINCIPAL.set(req, { id: "viewer", name: "viewer" });
    return { id: "viewer", name: "viewer", viewer: true, capabilities: "[]" };
  }
  if (env.ADMIN_TOKEN && (await safeEqual(tok, env.ADMIN_TOKEN))) {
    REQUEST_PRINCIPAL.set(req, { id: ADMIN_ID, name: ADMIN_ID });
    if (allowAdmin || adminOnly) return { id: ADMIN_ID, name: ADMIN_ID, admin: true, capabilities: "[]" };
    throw new HttpError(403, "forbidden", "this endpoint requires an agent token, not the admin token");
  }
  if (adminOnly) throw new HttpError(403, "forbidden", "admin token required");
  const minute = Math.floor(now / MIN);
  const a = await env.DB.prepare(
    `UPDATE agents SET last_seen_at = ?1, offline_notified = 0,
       rl_count = CASE WHEN rl_window = ?2 THEN rl_count + 1 ELSE 1 END, rl_window = ?2
     WHERE token_hash = ?3 AND disabled = 0
     RETURNING id, name, capabilities, meta, state, note, created_at, last_seen_at, disabled, rl_count`
  ).bind(now, minute, await sha256(tok)).first();
  if (!a) throw new HttpError(401, "unauthorized", "invalid or revoked token");
  REQUEST_PRINCIPAL.set(req, { id: a.id, name: a.name });
  if (a.rl_count > LIMITS.requests_per_minute_per_agent) {
    const retry = Math.ceil(((minute + 1) * MIN - now) / 1000);
    throw new HttpError(429, "rate_limited", `limit is ${LIMITS.requests_per_minute_per_agent} requests/minute per agent`, { retry_after_s: retry }, { "Retry-After": String(retry) });
  }
  return a;
}

// ---------- idempotency ----------

async function idempotent(req, env, principal, raw, now, handler) {
  const key = req.headers.get("Idempotency-Key");
  if (!key) return runCatching(handler);
  if (key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-128 printable ASCII characters");
  }
  const url = new URL(req.url);
  const fp = await sha256(`${req.method} ${url.pathname}\n${raw}`);
  const inserted = await env.DB.prepare(
    "INSERT INTO idempotency (agent_id, key, fingerprint, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING RETURNING key"
  ).bind(principal.id, key, fp, now).first();
  if (!inserted) {
    const prev = await env.DB.prepare("SELECT fingerprint, status, response FROM idempotency WHERE agent_id = ?1 AND key = ?2").bind(principal.id, key).first();
    if (!prev) throw new HttpError(409, "idempotency_in_progress", "retry shortly", { retry_after_s: 1 }, { "Retry-After": "1" });
    if (prev.fingerprint !== fp) throw new HttpError(422, "idempotency_key_reused", "this Idempotency-Key was already used for a different request");
    if (prev.response == null) throw new HttpError(409, "idempotency_in_progress", "the original request is still running; retry shortly", { retry_after_s: 1 }, { "Retry-After": "1" });
    return new Response(prev.response, {
      status: prev.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Idempotent-Replay": "true", ...SECURITY_HEADERS },
    });
  }
  let resp;
  try {
    resp = await runCatching(handler);
  } catch (e) {
    await env.DB.prepare("DELETE FROM idempotency WHERE agent_id = ?1 AND key = ?2").bind(principal.id, key).run();
    throw e;
  }
  if (resp.status >= 500 || resp.status === 429) {
    await env.DB.prepare("DELETE FROM idempotency WHERE agent_id = ?1 AND key = ?2").bind(principal.id, key).run();
  } else {
    await env.DB.prepare("UPDATE idempotency SET status = ?3, response = ?4 WHERE agent_id = ?1 AND key = ?2")
      .bind(principal.id, key, resp.status, await resp.clone().text()).run();
  }
  return resp;
}

async function runCatching(handler) {
  try {
    return await handler();
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return e.toResponse();
    throw e;
  }
}

// ---------- handlers ----------

async function register(req, env, now) {
  await ipRate(env, req, "register", LIMITS.registrations_per_hour_per_ip, HOUR, now);
  const { body } = await readBody(req);
  if (!env.ENROLLMENT_KEY) throw new HttpError(503, "not_configured", "registration is disabled: the operator has not set an enrollment key");
  if (!(await safeEqual(body.enrollment_key, env.ENROLLMENT_KEY))) throw new HttpError(403, "invalid_enrollment_key", "enrollment_key is missing or wrong; ask the operator for it");
  const name = str(body.name, "name", { max: 64, required: true, pattern: NAME_RE });
  const caps = JSON.stringify(capabilities(body.capabilities));
  const meta = jsonField(body.meta, "meta", { max: 2048 });
  const token = newToken();
  const hash = await sha256(token);
  const existing = await env.DB.prepare("SELECT id, disabled FROM agents WHERE name = ?1").bind(name).first();
  let id;
  if (existing) {
    if (existing.disabled) throw new HttpError(403, "agent_revoked", "this agent name was revoked by the operator");
    if (body.rotate !== true) throw new HttpError(409, "name_taken", "an agent with this name exists; send \"rotate\": true to issue it a new token (the old token stops working)");
    id = existing.id;
    await env.DB.batch([
      env.DB.prepare("UPDATE agents SET token_hash = ?1, capabilities = ?2, meta = ?3, last_seen_at = ?4, offline_notified = 0 WHERE id = ?5").bind(hash, caps, meta, now, id),
      eventStmt(env.DB, now, "agent.token_rotated", id, null, { agent_id: id, name }),
    ]);
  } else {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM agents").first();
    if (count.n >= LIMITS.max_agents) throw new HttpError(507, "capacity", `agent limit (${LIMITS.max_agents}) reached`);
    id = "agt_" + randomHex(8);
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO agents (id, name, token_hash, capabilities, meta, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)"
        ).bind(id, name, hash, caps, meta, now),
        eventStmt(env.DB, now, "agent.registered", id, null, { agent_id: id, name, capabilities: JSON.parse(caps) }),
      ]);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "name_taken", "an agent with this name was just registered; retry with \"rotate\": true");
      throw e;
    }
  }
  return json(existing ? 200 : 201, {
    agent_id: id,
    name,
    token,
    token_type: "Bearer",
    rotated: !!existing,
    capabilities: JSON.parse(caps),
    heartbeat_interval_s: LIMITS.heartbeat_interval_s,
    warning: "Store this token now; it is shown only once and cannot be recovered. Never share it or post it in messages.",
  });
}

async function heartbeat(req, env, me, now) {
  const { body } = await readBody(req);
  const state = str(body.state, "state", { max: 32, def: me.state, pattern: /^[A-Za-z0-9_.-]+$/ });
  const note = str(body.note, "note", { max: 280, def: me.note });
  const [, claimed, cur] = await env.DB.batch([
    env.DB.prepare("UPDATE agents SET state = ?1, note = ?2 WHERE id = ?3").bind(state, note, me.id),
    env.DB.prepare("SELECT id, title, lease_expires_at FROM tasks WHERE claimed_by = ?1 AND status = 'claimed'").bind(me.id),
    env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events"),
  ]);
  return json(200, {
    ok: true,
    agent_id: me.id,
    server_time: iso(now),
    heartbeat_interval_s: LIMITS.heartbeat_interval_s,
    latest_cursor: cur.results[0].seq,
    my_claimed_tasks: claimed.results.map((t) => ({ id: t.id, title: t.title, lease_expires_in_s: Math.round((t.lease_expires_at - now) / 1000) })),
  });
}

async function listAgents(env, url, now) {
  const rows = await env.DB.prepare(
    "SELECT id, name, capabilities, meta, state, note, created_at, last_seen_at, disabled FROM agents ORDER BY name"
  ).all();
  const want = url.searchParams.get("presence");
  let agents = rows.results.map((a) => fmtAgent(a, now));
  if (want) agents = agents.filter((a) => want.split(",").includes(a.presence));
  return json(200, { agents, server_time: iso(now) });
}

async function resolveAgent(env, ref, field) {
  const v = str(ref, field, { max: 64, required: true });
  const a = await env.DB.prepare("SELECT id, name, disabled FROM agents WHERE id = ?1 OR name = ?1").bind(v).first();
  if (!a || a.disabled) throw new HttpError(404, "unknown_agent", `${field}: no active agent with id or name ${JSON.stringify(v)}`);
  return a;
}

async function postMessage(req, env, me, body, now) {
  const msg = str(body.body, "body", { max: LIMITS.max_message_chars, required: true });
  let target = null;
  let targetName = null;
  if (body.to !== undefined && body.to !== null && body.to !== "*") {
    const a = await resolveAgent(env, body.to, "to");
    target = a.id;
    targetName = a.name;
  }
  const payload = {
    body: msg,
    subject: str(body.subject, "subject", { max: 200, def: undefined }),
    data: body.data === undefined ? undefined : JSON.parse(jsonField(body.data, "data")),
    reply_to: body.reply_to === undefined ? undefined : clampInt(body.reply_to, 0, 0, Number.MAX_SAFE_INTEGER, "reply_to"),
    artifacts: body.artifacts === undefined ? undefined : JSON.parse(artifacts(body.artifacts)),
  };
  const row = await env.DB.prepare(EVENT_SQL + " RETURNING seq, ts, type, actor, target, payload")
    .bind(now, "message", me.id, target, JSON.stringify(payload)).first();
  return json(201, { event: fmtEvent({ ...row, actor_name: me.name, target_name: targetName }) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollEvents(env, me, url, now) {
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, LIMITS.events_page_max, "limit");
  const wait = clampInt(url.searchParams.get("wait"), 0, 0, LIMITS.events_wait_max_s, "wait");
  const afterRaw = url.searchParams.get("after") ?? "0";
  const head = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq, COALESCE(MIN(seq), 0) AS min_seq FROM events").first();
  if (afterRaw === "latest") {
    return json(200, { events: [], next_cursor: head.max_seq, has_more: false, oldest_cursor: Math.max(0, head.min_seq - 1), server_time: iso(now) });
  }
  const after = clampInt(afterRaw, 0, 0, Number.MAX_SAFE_INTEGER, "after");
  const typeFilter = url.searchParams.get("types");
  const types = typeFilter ? typeFilter.split(",").filter(Boolean).slice(0, 20) : null;
  const q = env.DB.prepare(
    `SELECT e.seq, e.ts, e.type, e.actor, e.target, e.payload, a.name AS actor_name, t.name AS target_name
     FROM events e LEFT JOIN agents a ON a.id = e.actor LEFT JOIN agents t ON t.id = e.target
     WHERE e.seq > ?1 AND (e.target IS NULL OR e.target = ?2 OR e.actor = ?2)
       AND (?3 IS NULL OR e.type IN (SELECT value FROM json_each(?3)))
     ORDER BY e.seq LIMIT ?4`
  ).bind(after, me.id, types ? JSON.stringify(types) : null, limit + 1);
  const deadline = Date.now() + wait * 1000;
  let rows = (await q.all()).results;
  while (rows.length === 0 && Date.now() + 2000 < deadline) {
    await sleep(2000);
    rows = (await q.all()).results;
  }
  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);
  // Events skipped by the visibility filter still advance the cursor when the page is not full.
  const next = rows.length ? rows[rows.length - 1].seq : Math.max(after, hasMore ? after : Math.min(head.max_seq, after > head.max_seq ? after : head.max_seq));
  return json(200, {
    events: rows.map(fmtEvent),
    next_cursor: next,
    has_more: hasMore,
    oldest_cursor: Math.max(0, head.min_seq - 1),
    cursor_expired: after > 0 && after < head.min_seq - 1,
    server_time: iso(new Date().getTime()),
  });
}

const TASK_STATUSES = ["open", "claimed", "done", "failed", "cancelled"];

async function createTask(env, me, body, now) {
  const title = str(body.title, "title", { max: 200, required: true });
  const description = str(body.description, "description", { max: LIMITS.max_message_chars });
  const payload = jsonField(body.payload, "payload");
  const priority = clampInt(body.priority, 0, -100, 100, "priority");
  const maxAttempts = clampInt(body.max_attempts, 3, 1, 10, "max_attempts");
  const reqCap = body.required_capability == null ? null : str(body.required_capability, "required_capability", { max: 40, pattern: CAP_RE });
  let assignee = null;
  if (body.assign_to != null) assignee = await resolveAgent(env, body.assign_to, "assign_to");
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('open','claimed')").first();
  if (open.n >= LIMITS.max_open_tasks) throw new HttpError(507, "capacity", `too many unfinished tasks (${LIMITS.max_open_tasks}); finish or cancel some first`);
  const id = "tsk_" + randomHex(8);
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tasks (id, title, description, payload, priority, required_capability, assigned_to, max_attempts, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10) RETURNING *`
    ).bind(id, title, description, payload, priority, reqCap, assignee?.id ?? null, maxAttempts, me.id, now),
    eventStmt(env.DB, now, "task.created", me.id, assignee?.id ?? null, { task_id: id, title, priority, required_capability: reqCap, assigned_to: assignee?.id ?? null }),
  ]);
  return json(201, { task: fmtTask(ins.results[0], now, me.id) });
}

async function listTasks(env, me, url, now) {
  const where = [];
  const binds = [];
  const status = url.searchParams.get("status");
  if (status) {
    const st = status.split(",").filter((s) => TASK_STATUSES.includes(s));
    if (!st.length) throw new HttpError(400, "invalid_field", `status must be one of ${TASK_STATUSES.join(",")}`);
    binds.push(JSON.stringify(st));
    where.push(`status IN (SELECT value FROM json_each(?${binds.length}))`);
  }
  for (const f of ["claimed_by", "created_by", "assigned_to"]) {
    let v = url.searchParams.get(f);
    if (!v) continue;
    if (v === "me") v = me.id;
    binds.push(v);
    where.push(`${f} = ?${binds.length}`);
  }
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200, "limit");
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 100000, "offset");
  binds.push(limit + 1, offset);
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END, priority DESC, created_at DESC
       LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`
    ).bind(...binds).all()
  ).results;
  const hasMore = rows.length > limit;
  return json(200, { tasks: rows.slice(0, limit).map((t) => fmtTask(t, now, me.id)), has_more: hasMore, next_offset: hasMore ? offset + limit : null });
}

async function getTask(env, me, id, now) {
  const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?1").bind(id).first();
  if (!t) throw new HttpError(404, "not_found", `no task ${id}`);
  return json(200, { task: fmtTask(t, now, me.id) });
}

function leaseSeconds(v) {
  return clampInt(v, LIMITS.lease_default_s, LIMITS.lease_min_s, LIMITS.lease_max_s, "lease_seconds");
}

// Atomic claim: a single UPDATE ... WHERE id = (SELECT ... LIMIT 1) under D1's
// single-writer serialization. Two agents can never both get the same task.
async function claimTask(env, me, body, now) {
  const lease = leaseSeconds(body.lease_seconds);
  const leaseId = "lse_" + randomHex(16);
  const taskId = body.task_id == null ? null : str(body.task_id, "task_id", { max: 64 });
  const expires = now + lease * 1000;
  const [upd] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks SET status = 'claimed', claimed_by = ?1, lease_id = ?2, lease_expires_at = ?3,
              attempts = attempts + 1, updated_at = ?4, error = NULL
       WHERE id = (
         SELECT id FROM tasks
         WHERE (status = 'open' OR (status = 'claimed' AND lease_expires_at < ?4))
           AND attempts < max_attempts
           AND (assigned_to IS NULL OR assigned_to = ?1)
           AND (required_capability IS NULL OR required_capability IN (SELECT value FROM json_each(?5)))
           AND (?6 IS NULL OR id = ?6)
         ORDER BY priority DESC, created_at ASC
         LIMIT 1)
       RETURNING *`
    ).bind(me.id, leaseId, expires, now, me.capabilities || "[]", taskId),
    env.DB.prepare(
      `INSERT INTO events (ts, type, actor, target, payload)
       SELECT ?1, 'task.claimed', ?2, NULL, json_object('task_id', id, 'title', title, 'attempt', attempts, 'lease_expires_at', ?3)
       FROM tasks WHERE lease_id = ?4`
    ).bind(now, me.id, iso(expires), leaseId),
  ]);
  const t = upd.results[0];
  if (!t) {
    if (taskId) {
      const cur = await env.DB.prepare("SELECT status, claimed_by, assigned_to, required_capability, attempts, max_attempts FROM tasks WHERE id = ?1").bind(taskId).first();
      if (!cur) throw new HttpError(404, "not_found", `no task ${taskId}`);
      throw new HttpError(409, "not_claimable", "task is not claimable by you right now", {
        status: cur.status, claimed_by: cur.claimed_by, assigned_to: cur.assigned_to,
        required_capability: cur.required_capability, attempts: cur.attempts, max_attempts: cur.max_attempts,
      });
    }
    return json(200, { task: null, retry_after_s: 15, message: "no claimable task right now" });
  }
  return json(200, { task: fmtTask(t, now, me.id), lease_id: leaseId, lease_expires_at: iso(expires), lease_expires_in_s: lease });
}

// Explain why a lease-guarded update matched nothing.
async function leaseFailure(env, me, id, leaseId) {
  const t = await env.DB.prepare("SELECT status, claimed_by, lease_id FROM tasks WHERE id = ?1").bind(id).first();
  if (!t) return new HttpError(404, "not_found", `no task ${id}`);
  if (!leaseId) return new HttpError(400, "invalid_field", "lease_id is required");
  return new HttpError(409, "lease_lost", "you no longer hold this task's lease (it expired and was reclaimed, released, cancelled or finished)", {
    status: t.status, claimed_by: t.claimed_by,
  });
}

async function renewTask(env, me, id, body, now) {
  const lease = leaseSeconds(body.lease_seconds);
  const leaseId = str(body.lease_id, "lease_id", { max: 64 });
  const t = await env.DB.prepare(
    "UPDATE tasks SET lease_expires_at = ?1, updated_at = ?2 WHERE id = ?3 AND lease_id = ?4 AND claimed_by = ?5 AND status = 'claimed' RETURNING *"
  ).bind(now + lease * 1000, now, id, leaseId, me.id).first();
  if (!t) throw await leaseFailure(env, me, id, leaseId);
  return json(200, { task: fmtTask(t, now, me.id), lease_id: leaseId, lease_expires_at: iso(t.lease_expires_at), lease_expires_in_s: lease });
}

async function finishTask(env, me, id, body, now, kind) {
  const leaseId = str(body.lease_id, "lease_id", { max: 64 });
  let stmt;
  let event;
  if (kind === "complete") {
    const result = body.result === undefined ? null : jsonField(body.result, "result");
    const arts = artifacts(body.artifacts);
    stmt = env.DB.prepare(
      `UPDATE tasks SET status = 'done', result = ?1, artifacts = ?2, completed_at = ?3, updated_at = ?3,
              lease_id = NULL, lease_expires_at = NULL
       WHERE id = ?4 AND lease_id = ?5 AND claimed_by = ?6 AND status = 'claimed' RETURNING *`
    ).bind(result, arts, now, id, leaseId, me.id);
    event = "task.completed";
  } else if (kind === "fail") {
    const error = str(body.error, "error", { max: 4000, required: true });
    const retry = body.retry !== false;
    stmt = env.DB.prepare(
      `UPDATE tasks SET
         status = CASE WHEN ?1 AND attempts < max_attempts THEN 'open' ELSE 'failed' END,
         claimed_by = CASE WHEN ?1 AND attempts < max_attempts THEN NULL ELSE claimed_by END,
         completed_at = CASE WHEN ?1 AND attempts < max_attempts THEN NULL ELSE ?2 END,
         error = ?3, updated_at = ?2, lease_id = NULL, lease_expires_at = NULL
       WHERE id = ?4 AND lease_id = ?5 AND claimed_by = ?6 AND status = 'claimed' RETURNING *`
    ).bind(retry ? 1 : 0, now, error, id, leaseId, me.id);
    event = "task.failed";
  } else {
    // release: give it back without consuming an attempt
    stmt = env.DB.prepare(
      `UPDATE tasks SET status = 'open', claimed_by = NULL, lease_id = NULL, lease_expires_at = NULL,
              attempts = MAX(0, attempts - 1), updated_at = ?1
       WHERE id = ?2 AND lease_id = ?3 AND claimed_by = ?4 AND status = 'claimed' RETURNING *`
    ).bind(now, id, leaseId, me.id);
    event = "task.released";
  }
  const t = await stmt.first();
  if (!t) throw await leaseFailure(env, me, id, leaseId);
  await eventStmt(env.DB, now, event, me.id, null, {
    task_id: t.id, title: t.title, status: t.status, attempts: t.attempts, max_attempts: t.max_attempts, created_by: t.created_by,
  }).run();
  return json(200, { task: fmtTask(t, now, me.id) });
}

async function cancelTask(env, me, id, body, now) {
  const reason = str(body.reason, "reason", { max: 1000, def: "cancelled" });
  const t = await env.DB.prepare(
    `UPDATE tasks SET status = 'cancelled', error = ?1, lease_id = NULL, lease_expires_at = NULL, updated_at = ?2, completed_at = ?2
     WHERE id = ?3 AND status IN ('open','claimed') AND (created_by = ?4 OR ?5) RETURNING *`
  ).bind(reason, now, id, me.id, me.admin ? 1 : 0).first();
  if (!t) {
    const cur = await env.DB.prepare("SELECT status, created_by FROM tasks WHERE id = ?1").bind(id).first();
    if (!cur) throw new HttpError(404, "not_found", `no task ${id}`);
    if (cur.created_by !== me.id && !me.admin) throw new HttpError(403, "forbidden", "only the task's creator (or the operator) can cancel it");
    throw new HttpError(409, "invalid_state", `task is already ${cur.status}`, { status: cur.status });
  }
  await eventStmt(env.DB, now, "task.cancelled", me.id, null, { task_id: t.id, title: t.title, reason, previous_owner: t.claimed_by }).run();
  return json(200, { task: fmtTask(t, now, me.id) });
}

async function clusterStatus(env, now, ctx) {
  const stale = now - LIMITS.stale_after_s * 1000;
  const offline = now - LIMITS.offline_after_s * 1000;
  const [agents, tasks, events, sweep, expired] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(disabled = 0 AND last_seen_at >= ?1), 0) AS online,
              COALESCE(SUM(disabled = 0 AND last_seen_at < ?1 AND last_seen_at >= ?2), 0) AS stale,
              COALESCE(SUM(disabled = 0 AND last_seen_at < ?2), 0) AS offline,
              COALESCE(SUM(disabled = 1), 0) AS revoked
       FROM agents`
    ).bind(stale, offline),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status"),
    env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS latest_cursor, COUNT(*) AS retained FROM events"),
    env.DB.prepare("SELECT v FROM kv_meta WHERE k = 'last_sweep_at'"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'claimed' AND lease_expires_at < ?1").bind(now),
  ]);
  const lastSweep = sweep.results[0] ? Number(sweep.results[0].v) : null;
  if (!lastSweep || now - lastSweep > 2 * MIN) ctx.waitUntil(runSweep(env, Date.now()));
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0]));
  for (const r of tasks.results) byStatus[r.status] = r.n;
  return json(200, {
    service: "agents-hub",
    version: VERSION,
    server_time: iso(now),
    agents: agents.results[0],
    tasks: { ...byStatus, expired_leases_pending_sweep: expired.results[0].n },
    events: events.results[0],
    last_sweep_at: iso(lastSweep),
    limits: LIMITS,
  });
}

async function revokeAgent(env, ref, now) {
  const a = await resolveAgent(env, ref, "agent");
  await env.DB.batch([
    env.DB.prepare("UPDATE agents SET disabled = 1, token_hash = ?1 WHERE id = ?2").bind("revoked:" + randomHex(16), a.id),
    env.DB.prepare(
      `UPDATE tasks SET status = 'open', claimed_by = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ?1
       WHERE claimed_by = ?2 AND status = 'claimed'`
    ).bind(now, a.id),
    eventStmt(env.DB, now, "agent.revoked", ADMIN_ID, null, { agent_id: a.id, name: a.name }),
  ]);
  return json(200, { ok: true, agent_id: a.id, name: a.name });
}

// ---------- operator logs ----------

// Admin token (header) or the read-only LOGS_KEY (header, or ?key= for browsers).
async function authenticateLogs(req, env, url) {
  const tok = bearer(req) || url.searchParams.get("key");
  if (!tok) throw new HttpError(401, "unauthorized", "logs need the admin token or the read-only logs key (Authorization: Bearer … or ?key=…)");
  if ((env.ADMIN_TOKEN && (await safeEqual(tok, env.ADMIN_TOKEN))) || (env.LOGS_KEY && (await safeEqual(tok, env.LOGS_KEY)))) {
    REQUEST_PRINCIPAL.set(req, { id: "operator", name: "operator" });
    return;
  }
  throw new HttpError(403, "forbidden", "logs need the admin token or the read-only logs key");
}

function logParams(url) {
  return {
    after: clampInt(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER, "after"),
    limit: clampInt(url.searchParams.get("limit"), 200, 1, 1000, "limit"),
    agent: url.searchParams.get("agent"),
    since: url.searchParams.get("since") ? Date.parse(url.searchParams.get("since")) || 0 : 0,
    desc: url.searchParams.get("order") === "desc",
    text: url.searchParams.get("format") === "text",
  };
}

function logResponse(p, items, cursorField, toLine, extra = {}) {
  const hasMore = items.length > p.limit;
  if (hasMore) items = items.slice(0, p.limit);
  const next = items.length ? items[items.length - 1][cursorField] : p.after;
  if (p.text) {
    const footer = `# ${items.length} entries; next: after=${next}${hasMore ? " (more available)" : ""}\n`;
    return new Response(items.map(toLine).join("\n") + (items.length ? "\n" : "") + footer, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
    });
  }
  return json(200, { entries: items, next_cursor: next, has_more: hasMore, ...extra });
}

// Full event log: every event, including direct messages between other agents.
async function eventLog(env, url) {
  const p = logParams(url);
  const types = url.searchParams.get("types");
  const rows = (
    await env.DB.prepare(
      `SELECT e.seq, e.ts, e.type, e.actor, e.target, e.payload, a.name AS actor_name, t.name AS target_name
       FROM events e LEFT JOIN agents a ON a.id = e.actor LEFT JOIN agents t ON t.id = e.target
       WHERE ${p.desc ? "(?1 = 0 OR e.seq < ?1)" : "e.seq > ?1"} AND e.ts >= ?2
         AND (?3 IS NULL OR e.actor = ?3 OR e.target = ?3 OR a.name = ?3 OR t.name = ?3 OR e.payload LIKE '%' || ?3 || '%')
         AND (?4 IS NULL OR e.type IN (SELECT value FROM json_each(?4)))
       ORDER BY e.seq ${p.desc ? "DESC" : "ASC"} LIMIT ?5`
    ).bind(p.after, p.since, p.agent, types ? JSON.stringify(types.split(",").filter(Boolean)) : null, p.limit + 1).all()
  ).results.map(fmtEvent);
  return logResponse(p, rows, "seq", (e) =>
    `#${e.seq} ${e.ts} ${e.type} ${e.actor_name || e.actor || "system"}${e.target ? " -> " + (e.target_name || e.target) : ""} ${JSON.stringify(e.payload)}`
  );
}

async function requestLog(env, url) {
  const p = logParams(url);
  const minStatus = clampInt(url.searchParams.get("min_status"), 0, 0, 599, "min_status");
  const rows = (
    await env.DB.prepare(
      `SELECT id, ts, agent_id, agent_name, ip, method, path, status, ms, error_code FROM request_log
       WHERE ${p.desc ? "(?1 = 0 OR id < ?1)" : "id > ?1"} AND ts >= ?2
         AND (?3 IS NULL OR agent_id = ?3 OR agent_name = ?3) AND status >= ?4
       ORDER BY id ${p.desc ? "DESC" : "ASC"} LIMIT ?5`
    ).bind(p.after, p.since, p.agent, minStatus, p.limit + 1).all()
  ).results.map((r) => ({ ...r, ts: iso(r.ts) }));
  return logResponse(p, rows, "id", (r) =>
    `#${r.id} ${r.ts} ${r.status} ${r.method} ${r.path} ${r.agent_name || "-"} ${r.ip || "-"} ${r.ms}ms${r.error_code ? " " + r.error_code : ""}`
  );
}

async function auditRequest(env, req, resp, started) {
  const url = new URL(req.url);
  const m = req.method;
  if ((m === "GET" || m === "HEAD") && resp.status < 400) return;
  if (m === "GET" && resp.status === 404 && !url.pathname.startsWith("/v1/")) return; // stray browser/scanner noise
  let code = null;
  if (resp.status >= 400) {
    try {
      code = (await resp.clone().json()).error?.code ?? null;
    } catch {}
  }
  const who = REQUEST_PRINCIPAL.get(req);
  await env.DB.prepare(
    "INSERT INTO request_log (ts, agent_id, agent_name, ip, method, path, status, ms, error_code) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
  ).bind(started, who?.id ?? null, who?.name ?? null, clientIp(req), m, url.pathname.slice(0, 300), resp.status, Date.now() - started, code).run();
}

// Lease expiry, stale-agent recovery and retention. Runs from cron every minute,
// and opportunistically from /v1/status.
async function runSweep(env, now) {
  const offline = now - LIMITS.offline_after_s * 1000;
  const db = env.DB;
  await db.batch([
    db.prepare(
      `INSERT INTO events (ts, type, actor, target, payload)
       SELECT ?1, 'agent.offline', NULL, NULL, json_object('agent_id', id, 'name', name, 'last_seen_at', last_seen_at)
       FROM agents WHERE disabled = 0 AND offline_notified = 0 AND last_seen_at < ?2`
    ).bind(now, offline),
    db.prepare(
      `INSERT INTO events (ts, type, actor, target, payload)
       SELECT ?1, 'task.released', NULL, NULL,
              json_object('task_id', t.id, 'title', t.title, 'reason', 'agent_offline', 'previous_owner', t.claimed_by,
                          'requeued', json(CASE WHEN t.attempts < t.max_attempts THEN 'true' ELSE 'false' END))
       FROM tasks t JOIN agents a ON a.id = t.claimed_by
       WHERE t.status = 'claimed' AND a.last_seen_at < ?2`
    ).bind(now, offline),
    db.prepare(
      `UPDATE tasks SET status = CASE WHEN attempts < max_attempts THEN 'open' ELSE 'failed' END,
              error = 'lease lost: owner went offline', claimed_by = CASE WHEN attempts < max_attempts THEN NULL ELSE claimed_by END,
              completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE ?1 END,
              lease_id = NULL, lease_expires_at = NULL, updated_at = ?1
       WHERE status = 'claimed' AND claimed_by IN (SELECT id FROM agents WHERE last_seen_at < ?2)`
    ).bind(now, offline),
    db.prepare("UPDATE agents SET offline_notified = 1 WHERE disabled = 0 AND offline_notified = 0 AND last_seen_at < ?1").bind(offline),
    db.prepare(
      `INSERT INTO events (ts, type, actor, target, payload)
       SELECT ?1, 'task.expired', NULL, NULL,
              json_object('task_id', id, 'title', title, 'previous_owner', claimed_by,
                          'requeued', json(CASE WHEN attempts < max_attempts THEN 'true' ELSE 'false' END))
       FROM tasks WHERE status = 'claimed' AND lease_expires_at < ?1`
    ).bind(now),
    db.prepare(
      `UPDATE tasks SET status = CASE WHEN attempts < max_attempts THEN 'open' ELSE 'failed' END,
              error = 'lease expired', claimed_by = CASE WHEN attempts < max_attempts THEN NULL ELSE claimed_by END,
              completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE ?1 END,
              lease_id = NULL, lease_expires_at = NULL, updated_at = ?1
       WHERE status = 'claimed' AND lease_expires_at < ?1`
    ).bind(now),
    db.prepare("DELETE FROM events WHERE ts < ?1").bind(now - LIMITS.event_retention_days * DAY),
    db.prepare("DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?1").bind(LIMITS.event_max_rows),
    db.prepare("DELETE FROM tasks WHERE status IN ('done','failed','cancelled') AND updated_at < ?1").bind(now - LIMITS.finished_task_retention_days * DAY),
    db.prepare("DELETE FROM idempotency WHERE created_at < ?1").bind(now - LIMITS.idempotency_ttl_hours * HOUR),
    db.prepare("DELETE FROM ip_rate WHERE window < ?1").bind(Math.floor(now / HOUR) - 1),
    db.prepare("DELETE FROM request_log WHERE ts < ?1").bind(now - LIMITS.request_log_retention_days * DAY),
    db.prepare("DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - ?1").bind(LIMITS.request_log_max_rows),
    db.prepare("INSERT INTO kv_meta (k, v) VALUES ('last_sweep_at', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(now)),
  ]);
}

// Cron runs the sweep in production; this per-isolate check also keeps it going
// where cron is unavailable (local dev) at the cost of one read per minute.
let lastSweepCheck = 0;
function maybeSweep(env, ctx, now) {
  if (now - lastSweepCheck < MIN) return;
  lastSweepCheck = now;
  ctx.waitUntil(
    (async () => {
      const r = await env.DB.prepare("SELECT v FROM kv_meta WHERE k = 'last_sweep_at'").first();
      if (!r || now - Number(r.v) >= MIN) await runSweep(env, now);
    })().catch((e) => console.error("sweep failed", String(e)))
  );
}

// ---------- router ----------

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;
  const now = Date.now();
  const base = (env.PUBLIC_BASE_URL || url.origin).replace(/\/+$/, "");
  maybeSweep(env, ctx, now);

  if (m === "GET" || m === "HEAD") {
    if (path === "/" || path === "/docs" || path === "/llms.txt") {
      return text(docsMarkdown(base), "text/plain; charset=utf-8");
    }
    if (path === "/openapi.json") {
      return new Response(JSON.stringify(openapiSpec(base), null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300", ...SECURITY_HEADERS },
      });
    }
    if (path === "/client.py") return text(PY_CLIENT, "text/x-python; charset=utf-8");
    if (path === "/ui") {
      return new Response(UI_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          ...SECURITY_HEADERS,
        },
      });
    }
    if (path === "/v1/health") return json(200, { ok: true, service: "agents-hub", version: VERSION, server_time: iso(now) });
    if (path === "/favicon.ico" || path === "/robots.txt") return new Response(path === "/robots.txt" ? "User-agent: *\nDisallow: /v1/\n" : null, { status: path === "/robots.txt" ? 200 : 204 });
  }

  if (path === "/v1/agents/register" && m === "POST") return register(req, env, now);

  // Everything below needs a token.
  const parts = path.split("/").filter(Boolean); // ["v1", ...]
  if (parts[0] !== "v1") throw new HttpError(404, "not_found", `no route ${m} ${path}; read ${base}/ for the API documentation`);

  // operator logs
  if (parts[1] === "logs" && m === "GET" && parts.length <= 3) {
    await authenticateLogs(req, env, url);
    if (parts.length === 2) return eventLog(env, url);
    if (parts[2] === "requests") return requestLog(env, url);
  }

  // admin
  if (parts[1] === "admin") {
    const admin = await authenticate(req, env, now, { adminOnly: true });
    if (m === "POST" && parts[2] === "agents" && parts[4] === "revoke" && parts.length === 5) return revokeAgent(env, decodeURIComponent(parts[3]), now);
    if (m === "POST" && parts[2] === "sweep" && parts.length === 3) {
      await runSweep(env, now);
      return json(200, { ok: true, swept_at: iso(now), by: admin.id });
    }
    throw new HttpError(404, "not_found", `no route ${m} ${path}`);
  }

  const key = `${m} /${parts.slice(1).join("/")}`;
  const readOnly = { allowAdmin: true, allowViewer: true };

  if (key === "GET /me") {
    const me = await authenticate(req, env, now);
    return json(200, { agent: fmtAgent(me, now) });
  }
  if (key === "POST /heartbeat") return heartbeat(req, env, await authenticate(req, env, now), now);
  if (key === "GET /agents") {
    await authenticate(req, env, now, readOnly);
    return listAgents(env, url, now);
  }
  if (key === "GET /status") {
    await authenticate(req, env, now, readOnly);
    return clusterStatus(env, now, ctx);
  }
  if (key === "GET /events") return pollEvents(env, await authenticate(req, env, now, readOnly), url, now);
  if (key === "GET /tasks") return listTasks(env, await authenticate(req, env, now, readOnly), url, now);
  if (m === "GET" && parts[1] === "tasks" && parts.length === 3) return getTask(env, await authenticate(req, env, now, readOnly), parts[2], now);

  if (m === "POST") {
    const allowAdmin = key === "POST /messages" || key === "POST /tasks" || (parts[1] === "tasks" && parts[3] === "cancel");
    let action = null;
    if (key === "POST /messages") action = (me, body) => postMessage(req, env, me, body, now);
    else if (key === "POST /tasks") action = (me, body) => createTask(env, me, body, now);
    else if (key === "POST /tasks/claim") action = (me, body) => claimTask(env, me, body, now);
    else if (parts[1] === "tasks" && parts.length === 4) {
      const id = parts[2];
      const op = parts[3];
      if (op === "renew") action = (me, body) => renewTask(env, me, id, body, now);
      else if (op === "complete" || op === "fail" || op === "release") action = (me, body) => finishTask(env, me, id, body, now, op);
      else if (op === "cancel") action = (me, body) => cancelTask(env, me, id, body, now);
    }
    if (action) {
      const me = await authenticate(req, env, now, { allowAdmin });
      const { raw, body } = await readBody(req);
      return idempotent(req, env, me, raw, now, () => action(me, body));
    }
  }

  const known = ["/v1/logs", "/v1/logs/requests", "/v1/me", "/v1/heartbeat", "/v1/agents", "/v1/status", "/v1/events", "/v1/messages", "/v1/tasks", "/v1/tasks/claim"];
  if (known.includes(path) || /^\/v1\/tasks\/[^/]+(\/(renew|complete|fail|release|cancel))?$/.test(path)) {
    throw new HttpError(405, "method_not_allowed", `${m} is not supported on ${path}`);
  }
  throw new HttpError(404, "not_found", `no route ${m} ${path}; read ${base}/ for the API documentation`);
}

export default {
  async fetch(req, env, ctx) {
    const started = Date.now();
    let resp;
    try {
      resp = await route(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) resp = e.toResponse();
      else {
        console.error("unhandled", e && e.stack ? e.stack : String(e));
        resp = json(500, { error: { code: "internal", message: "internal error; retry with backoff" } }, { "Retry-After": "5" });
      }
    }
    ctx.waitUntil(auditRequest(env, req, resp, started).catch((e) => console.error("audit failed", String(e))));
    return resp;
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSweep(env, Date.now()));
  },
};
