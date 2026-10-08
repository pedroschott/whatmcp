// GET /ui — a small read-only inspector for the operator. Self-contained HTML,
// no external assets. It asks for the read-only LOGS_KEY (or the admin token),
// keeps it in sessionStorage, and calls the JSON API with it.

export const UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agents-hub inspector</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#262b36; --fg:#e6e8ee; --dim:#8b93a7; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --acc:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--bg); color:var(--fg); }
  header { display:flex; gap:12px; align-items:center; padding:10px 16px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:2; }
  header h1 { font-size:14px; margin:0; font-weight:600; }
  header .sp { flex:1; }
  input, select, button { font:inherit; background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 8px; }
  button { cursor:pointer; } button:hover { border-color:var(--acc); }
  main { display:grid; grid-template-columns: minmax(0,1.15fr) minmax(0,1fr); gap:12px; padding:12px 16px; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; min-width:0; }
  section h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:0; padding:8px 12px; border-bottom:1px solid var(--line); display:flex; gap:8px; align-items:center; }
  section h2 .sp { flex:1; }
  .full { grid-column: 1 / -1; }
  .stats { display:flex; flex-wrap:wrap; gap:18px; padding:10px 12px; }
  .stat b { font-size:18px; display:block; } .stat span { color:var(--dim); font-size:11px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:5px 10px; border-bottom:1px solid var(--line); vertical-align:top; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:280px; }
  th { color:var(--dim); font-weight:500; font-size:11px; }
  tr.sel td { background:#1f2633; } tbody tr { cursor:pointer; } tbody tr:hover td { background:#1b202a; }
  .pill { display:inline-block; padding:0 7px; border-radius:10px; font-size:11px; border:1px solid currentColor; }
  .online,.done { color:var(--ok); } .stale,.claimed { color:var(--warn); } .offline,.failed,.revoked { color:var(--bad); } .open { color:var(--acc); } .cancelled { color:var(--dim); }
  .scroll { max-height:420px; overflow:auto; }
  pre { margin:0; padding:8px 12px; white-space:pre-wrap; word-break:break-word; }
  .log div { padding:2px 12px; border-bottom:1px solid #1d212a; white-space:pre-wrap; word-break:break-word; }
  .log .t { color:var(--dim); } .log .ty { color:var(--acc); } .log .msg { color:#f0c674; }
  .dim { color:var(--dim); } .err { color:var(--bad); padding:8px 12px; }
  .comms { display:grid; grid-template-columns: 230px minmax(0,1fr); height:460px; }
  .convs { border-right:1px solid var(--line); overflow:auto; }
  .conv { padding:7px 12px; border-bottom:1px solid var(--line); cursor:pointer; }
  .conv:hover { background:#1b202a; } .conv.sel { background:#1f2633; }
  .conv b { font-weight:600; } .conv .dim { font-size:11px; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .thread { overflow:auto; padding:10px 14px; }
  .bubble { max-width:78%; margin:0 0 10px; padding:7px 10px; border-radius:8px; background:#1d2330; border:1px solid var(--line); }
  .bubble.bc { border-color:#3a3320; background:#221f16; }
  .bubble .hd { font-size:11px; color:var(--dim); margin-bottom:3px; }
  .bubble .hd b { color:var(--acc); font-weight:600; } .bubble .hd .to { color:#c3a6ff; }
  .bubble .body { white-space:pre-wrap; word-break:break-word; }
  .bubble .extra { margin-top:4px; font-size:11px; color:var(--dim); white-space:pre-wrap; word-break:break-word; }
  .right { margin-left:auto; }
  #login { max-width:420px; margin:12vh auto; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; }
  #login input { width:100%; margin:8px 0; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
</style></head>
<body>
<div id="login" hidden>
  <h1 style="font-size:15px;margin:0 0 6px">agents-hub inspector</h1>
  <div class="dim">Paste the read-only logs key (LOGS_KEY) or the admin token. It is kept only in this browser tab.</div>
  <form id="lf"><input id="key" type="password" autocomplete="off" placeholder="logs_… or adm_…" autofocus><button>Open</button></form>
  <div id="lerr" class="err"></div>
</div>
<div id="app" hidden>
<header>
  <h1>agents-hub</h1><span class="dim" id="srv"></span><span class="sp"></span>
  <label class="dim"><input type="checkbox" id="auto" checked> auto-refresh 5s</label>
  <button id="refresh">refresh</button><button id="logout">lock</button>
</header>
<main>
  <section class="full"><h2>cluster</h2><div class="stats" id="stats"></div></section>
  <section class="full">
    <h2>communication <span class="dim" id="ccount"></span><span class="sp"></span><input id="csearch" placeholder="search messages" size="24"></h2>
    <div class="comms"><div class="convs" id="convs"></div><div class="thread" id="thread"></div></div>
  </section>
  <section>
    <h2>agents <span class="dim" id="acount"></span><span class="sp"></span>
      <select id="pfilter"><option value="active">active (not revoked)</option><option value="">all</option><option>online</option><option>stale</option><option>offline</option><option>revoked</option></select></h2>
    <div class="scroll"><table><thead><tr><th>name</th><th>presence</th><th>state</th><th>seen</th><th>note</th><th>caps</th><th>host</th></tr></thead><tbody id="agents"></tbody></table></div>
  </section>
  <section>
    <h2>agent detail<span class="sp"></span><button id="clearsel" hidden>clear filter</button></h2>
    <div class="scroll"><pre id="detail" class="dim">click an agent to see its record, its tasks and filter the log</pre></div>
  </section>
  <section class="full">
    <h2>tasks <span class="dim" id="tcount"></span><span class="sp"></span>
      <select id="tfilter"><option value="open,claimed">open + claimed</option><option value="">all</option><option>open</option><option>claimed</option><option>done</option><option>failed</option><option>cancelled</option></select></h2>
    <div class="scroll" style="max-height:300px"><table><thead><tr><th>id</th><th>status</th><th>title</th><th>prio</th><th>claimed by</th><th>lease</th><th>tries</th><th>needs</th><th>updated</th></tr></thead><tbody id="tasks"></tbody></table></div>
  </section>
  <section class="full">
    <h2>event log <span class="dim" id="lscope">all agents</span><span class="sp"></span>
      <input id="ltypes" placeholder="types e.g. message,task.claimed" size="30">
      <select id="lkind"><option value="events">events</option><option value="requests">requests</option></select></h2>
    <div class="scroll log" id="log" style="max-height:520px"></div>
  </section>
</main>
</div>
<script>
(function () {
  var KEY = sessionStorage.getItem("ahub_key") || "";
  var sel = null, agentsById = {}, timer = null, conv = "*all", lastThreadKey = "";
  var $ = function (id) { return document.getElementById(id); };
  if (location.hash.indexOf("#key=") === 0) { KEY = decodeURIComponent(location.hash.slice(5)); sessionStorage.setItem("ahub_key", KEY); history.replaceState(null, "", location.pathname); }

  function api(path) {
    return fetch(path, { headers: { Authorization: "Bearer " + KEY }, cache: "no-store" }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error((j.error && j.error.code) + ": " + (j.error && j.error.message)); return j; });
    });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function ago(s) { if (s == null) return ""; if (s < 60) return s + "s"; if (s < 3600) return Math.round(s / 60) + "m"; if (s < 86400) return Math.round(s / 3600) + "h"; return Math.round(s / 86400) + "d"; }
  function since(iso) { return iso ? ago(Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))) + " ago" : ""; }
  function name(id) { return id ? (agentsById[id] ? agentsById[id].name : id) : ""; }
  function row(cells, onclick, cls) {
    var tr = el("tr", cls);
    cells.forEach(function (c) { var td = el("td"); if (c && c.nodeType) td.appendChild(c); else td.textContent = c == null ? "" : String(c); td.title = td.textContent; tr.appendChild(td); });
    if (onclick) tr.onclick = onclick;
    return tr;
  }
  function pill(v) { return el("span", "pill " + v, v); }

  function showLogin(msg) { $("app").hidden = true; $("login").hidden = false; $("lerr").textContent = msg || ""; }
  $("lf").onsubmit = function (e) { e.preventDefault(); KEY = $("key").value.trim(); sessionStorage.setItem("ahub_key", KEY); start(); };
  $("logout").onclick = function () { sessionStorage.removeItem("ahub_key"); KEY = ""; clearInterval(timer); showLogin(); };
  $("refresh").onclick = refresh;
  $("pfilter").onchange = refresh; $("tfilter").onchange = refresh; $("lkind").onchange = refresh; $("ltypes").onchange = refresh; $("csearch").oninput = function () { lastThreadKey = ""; refresh(); };
  $("auto").onchange = function () { clearInterval(timer); if ($("auto").checked) timer = setInterval(refresh, 5000); };
  $("clearsel").onclick = function () { sel = null; $("clearsel").hidden = true; $("detail").textContent = "click an agent to see its record, its tasks and filter the log"; $("detail").className = "dim"; refresh(); };

  function renderStatus(s) {
    $("srv").textContent = "v" + s.version + " · " + new Date(s.server_time).toLocaleTimeString() + " · last sweep " + since(s.last_sweep_at);
    var box = $("stats"); box.textContent = "";
    [["online", s.agents.online, "online"], ["stale", s.agents.stale, "stale"], ["offline", s.agents.offline, "offline"], ["revoked", s.agents.revoked, "revoked"],
     ["open tasks", s.tasks.open, "open"], ["claimed", s.tasks.claimed, "claimed"], ["done", s.tasks.done, "done"], ["failed", s.tasks.failed, "failed"],
     ["events retained", s.events.retained, ""], ["latest cursor", s.events.latest_cursor, ""]].forEach(function (x) {
      var d = el("div", "stat"); d.appendChild(el("b", x[2], x[1])); d.appendChild(el("span", null, x[0])); box.appendChild(d);
    });
  }
  function renderAgents(list) {
    agentsById = {}; list.forEach(function (a) { agentsById[a.id] = a; });
    var f = $("pfilter").value, tb = $("agents"); tb.textContent = "";
    var shown = list.filter(function (a) { return !f || a.presence === f || (f === "active" && a.presence !== "revoked"); });
    var order = { online: 0, stale: 1, offline: 2, revoked: 3 };
    shown.sort(function (a, b) { return order[a.presence] - order[b.presence] || a.name.localeCompare(b.name); });
    shown.forEach(function (a) {
      tb.appendChild(row([a.name, pill(a.presence), a.state, ago(a.seconds_since_seen), a.note, (a.capabilities || []).join(","), (a.meta && (a.meta.host || a.meta.os)) || ""],
        function () { sel = a.id; $("clearsel").hidden = false; refresh(); }, sel === a.id ? "sel" : ""));
    });
    $("acount").textContent = shown.length + "/" + list.length;
  }
  function renderTasks(list) {
    var tb = $("tasks"); tb.textContent = "";
    list.forEach(function (t) {
      tb.appendChild(row([t.id, pill(t.status), t.title, t.priority, name(t.claimed_by), t.lease_expires_in_s == null ? "" : t.lease_expires_in_s + "s", t.attempts + "/" + t.max_attempts, t.required_capability || (t.assigned_to ? "@" + name(t.assigned_to) : ""), since(t.updated_at)],
        function () { $("detail").className = ""; $("detail").textContent = JSON.stringify(t, null, 2); }));
    });
    $("tcount").textContent = list.length + (list.length >= 200 ? "+" : "");
  }
  function renderLog(entries, kind) {
    var box = $("log"); box.textContent = "";
    entries.forEach(function (e) {
      var d = el("div");
      if (kind === "events") {
        d.appendChild(el("span", "t", "#" + e.seq + " " + e.ts.replace("T", " ").slice(0, 19) + " "));
        d.appendChild(el("span", "ty", e.type + " "));
        d.appendChild(el("span", null, (e.actor_name || e.actor || "system") + (e.target ? " → " + (e.target_name || e.target) : "") + " "));
        if (e.type === "message") d.appendChild(el("span", "msg", (e.payload.subject ? "[" + e.payload.subject + "] " : "") + e.payload.body));
        else d.appendChild(el("span", "dim", JSON.stringify(e.payload)));
      } else {
        d.appendChild(el("span", "t", "#" + e.id + " " + e.ts.replace("T", " ").slice(0, 19) + " "));
        d.appendChild(el("span", e.status >= 400 ? "failed" : "done", e.status + " "));
        d.appendChild(el("span", null, e.method + " " + e.path + " " + (e.agent_name || "-") + " " + (e.ip || "") + " " + e.ms + "ms " + (e.error_code || "")));
      }
      box.appendChild(d);
    });
    if (!entries.length) box.appendChild(el("div", "dim", "no entries"));
  }

  function convKey(e) { return e.target ? [e.actor, e.target].sort().join("|") : "*broadcast"; }
  function convLabel(k) {
    if (k === "*all") return "All messages";
    if (k === "*broadcast") return "Broadcasts (everyone)";
    return k.split("|").map(name).join(" ↔ ");
  }
  function renderComms(entries) {
    var q = $("csearch").value.trim().toLowerCase();
    var msgs = entries.slice().reverse(); // oldest first
    msgs.forEach(function (e) {
      if (e.actor && e.actor_name && !agentsById[e.actor]) agentsById[e.actor] = { name: e.actor_name };
      if (e.target && e.target_name && !agentsById[e.target]) agentsById[e.target] = { name: e.target_name };
    });
    if (sel) msgs = msgs.filter(function (e) { return e.actor === sel || e.target === sel || !e.target; });
    if (q) msgs = msgs.filter(function (e) { return JSON.stringify(e.payload).toLowerCase().indexOf(q) >= 0 || (e.actor_name || "").toLowerCase().indexOf(q) >= 0; });
    var convs = { "*all": { n: msgs.length, last: msgs[msgs.length - 1] } };
    msgs.forEach(function (e) { var k = convKey(e); var c = convs[k] || (convs[k] = { n: 0 }); c.n++; c.last = e; });
    if (!convs[conv]) conv = "*all";
    var keys = Object.keys(convs).sort(function (a, b) {
      if (a === "*all") return -1; if (b === "*all") return 1;
      return (convs[b].last ? convs[b].last.seq : 0) - (convs[a].last ? convs[a].last.seq : 0);
    });
    var list = $("convs"); list.textContent = "";
    keys.forEach(function (k) {
      var c = convs[k], d = el("div", "conv" + (k === conv ? " sel" : ""));
      d.appendChild(el("b", null, convLabel(k) + " "));
      d.appendChild(el("span", "dim", c.n + " msg" + (c.last ? " · " + since(c.last.ts) + " · " + (c.last.actor_name || "") + ": " + c.last.payload.body : "")));
      d.onclick = function () { conv = k; renderComms(entries); };
      list.appendChild(d);
    });
    var th = $("thread");
    var atBottom = th.scrollHeight - th.scrollTop - th.clientHeight < 40;
    var shown = conv === "*all" ? msgs : msgs.filter(function (e) { return convKey(e) === conv; });
    var key = conv + ":" + (sel || "") + ":" + shown.length + ":" + (shown.length ? shown[shown.length - 1].seq : 0) + ":" + q;
    if (key === lastThreadKey) return;
    th.textContent = "";
    var left = conv.indexOf("|") > 0 ? conv.split("|")[0] : null;
    shown.forEach(function (e) {
      var b = el("div", "bubble" + (e.target ? "" : " bc") + (left && e.actor !== left ? " right" : ""));
      var hd = el("div", "hd");
      hd.appendChild(el("b", null, e.actor_name || e.actor || "system"));
      hd.appendChild(el("span", "to", " → " + (e.target ? (e.target_name || e.target) : "everyone")));
      hd.appendChild(el("span", null, "  #" + e.seq + " · " + e.ts.replace("T", " ").slice(0, 19) + (e.payload.reply_to ? " · reply to #" + e.payload.reply_to : "")));
      b.appendChild(hd);
      if (e.payload.subject) b.appendChild(el("div", null, "[" + e.payload.subject + "]"));
      b.appendChild(el("div", "body", e.payload.body));
      var extra = [];
      if (e.payload.data) extra.push("data: " + JSON.stringify(e.payload.data));
      (e.payload.artifacts || []).forEach(function (a) { extra.push("artifact: " + a.name + " — " + a.uri); });
      if (extra.length) b.appendChild(el("div", "extra", extra.join("\\n")));
      th.appendChild(b);
    });
    if (!shown.length) th.appendChild(el("div", "dim", "no messages yet"));
    $("ccount").textContent = msgs.length + " messages";
    if (atBottom || key.split(":")[0] !== lastThreadKey.split(":")[0]) th.scrollTop = th.scrollHeight;
    lastThreadKey = key;
  }

  function refresh() {
    var kind = $("lkind").value, types = $("ltypes").value.trim(), tf = $("tfilter").value;
    var agentQ = sel ? "&agent=" + encodeURIComponent(sel) : "";
    $("lscope").textContent = sel ? "agent " + name(sel) : "all agents";
    return Promise.all([
      api("/v1/status"), api("/v1/agents"),
      api("/v1/tasks?limit=200" + (tf ? "&status=" + tf : "")),
      api("/v1/logs" + (kind === "requests" ? "/requests" : "") + "?order=desc&limit=300" + agentQ + (types && kind === "events" ? "&types=" + encodeURIComponent(types) : "")),
      sel ? api("/v1/tasks?limit=50&claimed_by=" + encodeURIComponent(sel)) : null,
      api("/v1/logs?types=message&order=desc&limit=1000"),
    ]).then(function (r) {
      renderStatus(r[0]); renderAgents(r[1].agents); renderComms(r[5].entries); renderTasks(r[2].tasks); renderLog(r[3].entries, kind);
      if (sel && agentsById[sel]) { $("detail").className = ""; $("detail").textContent = JSON.stringify({ agent: agentsById[sel], claimed_tasks: r[4].tasks.filter(function (t) { return t.status === "claimed"; }) }, null, 2); }
    }).catch(function (e) {
      if (/unauthorized|forbidden/.test(e.message)) { clearInterval(timer); showLogin(e.message); } else { $("srv").textContent = "error: " + e.message; }
    });
  }
  function start() {
    if (!KEY) return showLogin();
    $("login").hidden = true; $("app").hidden = false;
    refresh(); clearInterval(timer); if ($("auto").checked) timer = setInterval(refresh, 5000);
  }
  start();
})();
</script>
</body></html>
`;
