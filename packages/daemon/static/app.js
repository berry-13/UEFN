// UEFN DevTools dashboard. Talks to the daemon over JSON-RPC (/rpc) and
// server-sent events (/stream). Everything from the runtime is rendered
// with textContent: event payloads come from game logs and are untrusted.

const STAGES = ["DISCOVERING", "VALIDATING", "BUILDING", "STARTING_SESSION", "WAITING_FOR_RUNTIME",
  "INITIALIZING", "RUNNING", "ASSERTING", "COLLECTING", "CLEANUP"];
const MAX_EVENTS = 2000;

// ── auth ────────────────────────────────────────────────────────────────
function readToken() {
  const match = /token=([^&]+)/.exec(location.hash);
  if (match) {
    try { sessionStorage.setItem("uefn-devtools-token", match[1]); } catch {}
    history.replaceState(null, "", location.pathname + "#overview");
    return match[1];
  }
  try { return sessionStorage.getItem("uefn-devtools-token"); } catch { return null; }
}
const token = readToken();

// ── tiny DOM helper ─────────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);

// ── state ───────────────────────────────────────────────────────────────
const store = {
  view: "overview",
  daemon: null,
  state: null,
  tests: [],
  testErrors: [],
  runs: [],
  events: [],
  eventFilter: "",
  paused: false,
  /** Snapshot shown while paused. */
  frozen: null,
  selectedEvent: null,
  trace: null,
  selectedRun: null,
  runDetail: null,
  /** Live runs keyed by runId. */
  live: new Map(),
  followRun: null,
  recordings: [],
  selectedRecording: null,
  recordingDetail: null,
  preview: null,
  recordName: "",
  recordKind: "scenario",
  genFormat: "yaml",
  genCounts: false,
  /** Simulator control values survive re-renders. */
  pg: { pid: "", team: 1, who: "", where: "", by: "(nobody)", dmg: 30 },
  doctor: null,
  doctorLoading: false,
  doctorMin: "info",
};

/** Live updates must not steal focus from a field the user is editing. */
function editing() {
  const el = document.activeElement;
  return !!el && $("main").contains(el) && (el.tagName === "INPUT" || el.tagName === "SELECT");
}

let rpcId = 1;
async function rpc(method, params = {}) {
  const res = await fetch("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

function toast(message) {
  $("sb-run").textContent = message;
}

// ── live data ───────────────────────────────────────────────────────────
let stateTimer = null;
function refreshStateSoon() {
  if (stateTimer) return;
  stateTimer = setTimeout(async () => {
    stateTimer = null;
    try { store.state = await rpc("state.get"); } catch { return; }
    renderChrome();
    if ((store.view === "overview" || store.view === "runtime" || store.view === "record") && !editing()) render();
  }, 250);
}

function liveRun(runId) {
  let run = store.live.get(runId);
  if (!run) {
    run = { runId, stages: [], currentStage: null, attempts: [], results: [], summary: null, discovered: [], errors: [] };
    store.live.set(runId, run);
  }
  return run;
}

function onActivity(msg) {
  if (msg.source === "recorder") {
    refreshStateSoon();
    if (msg.data.kind === "stopped") loadRecordings().then(() => selectRecording(msg.data.id));
    return;
  }
  if (msg.source !== "runner" || !msg.runId) return;
  const run = liveRun(msg.runId);
  const e = msg.data;
  if (!store.followRun || store.live.get(store.followRun)?.summary) store.followRun = msg.runId;
  switch (e.kind) {
    case "stage":
      run.currentStage = e.stage;
      if (STAGES.includes(e.stage) && !run.stages.includes(e.stage)) run.stages.push(e.stage);
      break;
    case "discovered": run.discovered = e.tests; run.errors = e.errors; break;
    case "attempt": run.attempts.push({ test: e.test, attempt: e.attempt, repeat: e.repeat }); break;
    case "test": run.results.push(e.result); break;
    case "done":
      run.summary = e.summary;
      toast(`Run ${e.summary.status} · ${(e.summary.durationMs / 1000).toFixed(2)}s`);
      loadRuns();
      refreshStateSoon();
      break;
  }
  if (store.view === "tests") render();
  renderChrome();
}

function onRuntime(msg) {
  // Pause freezes the timeline view, not the data: events keep arriving and
  // are shown on resume.
  store.events.push({ index: msg.index, ...msg.event });
  if (store.events.length > MAX_EVENTS) store.events.splice(0, store.events.length - MAX_EVENTS);
  $("sb-events").textContent = `${msg.index + 1} events`;
  if (store.view === "events" && !store.paused) renderEventsTableOnly();
  refreshStateSoon();
}

/**
 * The stream does not replay what was missed while disconnected, so after a
 * reconnect reload everything and settle live runs whose `done` we missed.
 */
async function resync() {
  await Promise.all([loadRuns(), loadEvents(), loadRecordings(), (async () => { try { store.state = await rpc("state.get"); } catch {} })()]);
  const stillRunning = new Set((store.state?.running ?? []).map((r) => r.runId));
  for (const run of store.live.values()) {
    if (run.summary || stillRunning.has(run.runId)) continue;
    try {
      const s = await rpc("runs.get", { runId: run.runId });
      if (s.status !== "running") run.summary = s;
    } catch {
      run.summary = { status: "error", error: "run finished while the dashboard was disconnected", durationMs: 0 };
    }
  }
  render();
}

function connectStream() {
  const source = new EventSource(`/stream?token=${encodeURIComponent(token)}`);
  let connectedBefore = false;
  source.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.channel === "hello") {
      store.daemon = msg.daemon;
      if (connectedBefore) resync();
      connectedBefore = true;
      renderChrome();
    }
    else if (msg.channel === "runtime") onRuntime(msg);
    else if (msg.channel === "activity") onActivity(msg);
  };
  source.onerror = () => { $("session-label").textContent = "Daemon unreachable — retrying"; $("session-dot").className = "dot err"; };
}

async function loadTests() {
  try {
    const r = await rpc("tests.list");
    store.tests = r.tests; store.testErrors = r.errors;
  } catch (e) { store.testErrors = [{ file: "", message: e.message }]; }
}
async function loadRuns() {
  try { store.runs = (await rpc("runs.list", { limit: 30 })).runs; } catch {}
  if (store.view === "runs" || store.view === "overview") render();
}
async function loadRecordings() {
  try { store.recordings = (await rpc("recordings.list")).recordings; } catch {}
  if (store.view === "record") render();
}
async function loadEvents() {
  try {
    const r = await rpc("events.query", { limit: 500 });
    store.events = r.events.map((e, i) => ({ index: r.total - r.events.length + i, ...e }));
  } catch {}
}

// ── actions ─────────────────────────────────────────────────────────────
async function act(label, fn) {
  toast(`${label}…`);
  try { await fn(); toast(`${label} ✓`); } catch (e) { toast(`${label} failed: ${e.message}`); }
  refreshStateSoon();
}
async function runTests(params) {
  const { runId } = await rpc("tests.run", params);
  store.followRun = runId;
  liveRun(runId);
  toast(`Run ${runId} started`);
  navigate("tests");
}

// ── chrome ──────────────────────────────────────────────────────────────
function renderChrome() {
  const s = store.state;
  $("project-name").textContent = s?.project ?? store.daemon?.project ?? "UEFN DevTools";
  document.title = `${s?.project ?? "UEFN"} · DevTools`;
  const status = s?.session?.status;
  // Live runs we have seen finish are authoritative over a stale state snapshot.
  const liveRunning = [...store.live.values()].some((r) => !r.summary);
  const snapshotRunning = (s?.running ?? []).some((r) => !store.live.get(r.runId)?.summary);
  const running = liveRunning || snapshotRunning;
  $("session-dot").className = "dot " + (running ? "busy" : status === "connected" || status === "playing" ? "on" : status === "failed" ? "err" : "");
  const recording = s?.recording;
  $("session-label").textContent = recording ? `Recording ${recording.kind === "bug" ? "bug " : ""}"${recording.name}"` : running ? "Running tests" : status ? `Session ${status}` : "No session";
  if (recording) $("session-dot").className = "dot err";
  $("sb-adapter").textContent = `adapter ${s?.adapter ?? store.daemon?.adapter ?? "—"}`;
  $("sb-runtime").textContent = s?.runtimeReady ? "runtime ready" : "runtime not ready";
  const c = s?.lastCompile;
  $("sb-verse").textContent = c ? (c.success ? "Verse ✓" : "Verse ✗") : "Verse —";
  $("sb-verse").className = c ? (c.success ? "pass" : "fail") : "";
  if (s) $("sb-events").textContent = `${s.eventCount} events`;
  for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("active", a.dataset.view === store.view);
}

// ── views ───────────────────────────────────────────────────────────────
function card(label, value, cls) {
  return h("div", { class: "card" }, h("div", { class: "label" }, label), h("div", { class: `value ${cls ?? ""}` }, value));
}

function viewOverview() {
  const s = store.state;
  const last = store.runs[0];
  const teams = Object.values(s?.game?.teams ?? {});
  return h("div", {},
    h("h1", {}, "Overview"),
    h("div", { class: "cards" },
      card("Session", s?.session?.status ?? "none"),
      card("Runtime", s?.runtimeReady ? "ready" : "not ready", s?.runtimeReady ? "pass" : "muted"),
      card("Game phase", s?.game?.phase ?? "—"),
      card("Last run", last ? `${last.passed}/${last.tests} passed` : "—", last ? (last.status === "passed" ? "pass" : "fail") : ""),
      card("Events", s?.eventCount ?? 0),
      ...teams.map((t) => card(`Team ${t.id} score`, t.score)),
    ),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: () => runTests({}) }, "Run all tests"),
      h("button", { onclick: () => act("Compile", () => rpc("compile")) }, "Compile Verse"),
      h("button", { onclick: () => act("Start session", () => rpc("session.start")) }, "Start session"),
      h("button", { onclick: () => act("Stop session", () => rpc("session.stop")) }, "Stop session"),
    ),
    s?.lastCompile?.diagnostics?.length ? h("div", {},
      h("h2", {}, "Last compile"),
      h("div", { class: "log" }, s.lastCompile.diagnostics.map((d) =>
        h("div", { class: d.severity === "error" ? "fail" : d.severity === "warning" ? "warn" : "muted" },
          `${d.severity.padEnd(7)} ${d.file ? `${d.file}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message}`)))) : null,
  );
}

function viewTests() {
  const repeat = h("input", { type: "number", min: 1, max: 1000, value: 1, title: "repeat" });
  const rows = store.tests.map((t) => h("tr", {},
    h("td", {}, t.name, t.skip ? h("span", { class: "badge" }, " skipped") : null),
    h("td", { class: "mono muted" }, t.id),
    h("td", { class: "mono muted" }, t.file),
    h("td", {}, h("span", { class: "badge" }, t.format === "yaml" ? "YAML" : "TS")),
    h("td", {}, h("button", { onclick: () => runTests({ filter: t.id, repeat: Number(repeat.value) || 1 }) }, "Run")),
  ));
  const run = store.followRun ? store.live.get(store.followRun) : null;
  return h("div", {},
    h("h1", {}, "Tests"),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: () => runTests({ repeat: Number(repeat.value) || 1 }) }, "Run all"),
      h("label", { class: "muted" }, "repeat ", repeat),
      h("button", { onclick: async () => { await loadTests(); render(); } }, "Reload"),
    ),
    store.testErrors.length ? h("div", { class: "notice" }, store.testErrors.map((e) => h("div", { class: "fail mono" }, `${e.file}: ${e.message}`))) : null,
    store.tests.length
      ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Test"), h("th", {}, "Id"), h("th", {}, "File"), h("th", {}, "Format"), h("th", {}, ""))), h("tbody", {}, rows))
      : h("div", { class: "empty" }, "No tests found in the tests directory."),
    run ? viewLiveRun(run) : null,
  );
}

function viewLiveRun(run) {
  const failedStage = run.summary?.failedStage;
  const stages = STAGES.map((st) => {
    const cls = st === failedStage ? "failed" : st === run.currentStage && !run.summary ? "current" : run.stages.includes(st) ? "done" : "";
    return h("span", { class: `stage ${cls}` }, st);
  });
  const repeated = run.attempts.some((a) => a.repeat > 1);
  const body = [];
  if (repeated) {
    const byTest = new Map();
    for (const a of run.attempts) {
      const entry = byTest.get(a.test.id) ?? { name: a.test.name, pass: 0, fail: 0, total: a.repeat, failures: [] };
      if (a.attempt.status === "passed") entry.pass++; else { entry.fail++; entry.failures.push(a.attempt); }
      byTest.set(a.test.id, entry);
    }
    for (const [id, e] of byTest) {
      const result = run.results.find((r) => r.id === id);
      body.push(h("div", {}, h("b", {}, e.name), ` — `, h("span", { class: "pass" }, `PASS ${e.pass}`), " ", h("span", { class: e.fail ? "fail" : "muted" }, `FAIL ${e.fail}`), h("span", { class: "muted" }, ` / ${e.total}`)));
      if (result) body.push(h("div", {}, `Reliability ${Math.round(result.reliability * 1000) / 10}%`));
      for (const c of result?.correlations ?? []) body.push(h("div", { class: "warn" }, `  correlation: ${c.description}`));
      for (const f of e.failures.slice(0, 5)) body.push(h("div", { class: "fail" }, `  #${f.iteration + 1} (seed ${f.seed}) ${f.error ?? ""}`));
      body.push(h("div", {}, " "));
    }
  } else {
    for (const { test, attempt } of run.attempts) {
      body.push(h("div", {}, h("b", {}, test.name)));
      const items = [
        ...attempt.steps.map((s) => ({ at: s.timestamp, ok: s.passed, text: s.description, err: s.error })),
        ...attempt.assertions.map((a) => ({ at: a.timestamp, ok: a.passed, text: a.description,
          err: a.passed ? null : `expected ${JSON.stringify(a.expected)}, received ${JSON.stringify(a.received)}` })),
      ].sort((a, b) => a.at - b.at);
      for (const it of items) {
        body.push(h("div", { class: it.ok ? "" : "fail" }, h("span", { class: it.ok ? "pass" : "fail" }, it.ok ? "✓ " : "✗ "), it.text));
        if (!it.ok && it.err) body.push(h("div", { class: "muted" }, `    ${it.err}`));
      }
      if (attempt.error && !items.some((i) => !i.ok)) body.push(h("div", { class: "fail" }, `✗ ${attempt.error}`));
      body.push(h("div", { class: attempt.status === "passed" ? "pass" : "fail" }, attempt.status === "passed" ? "PASS" : "FAIL"));
      if (attempt.artifactDir) body.push(h("div", { class: "muted" }, `artifacts: ${attempt.artifactDir}`));
      body.push(h("div", {}, " "));
    }
  }
  for (const e of run.errors) body.push(h("div", { class: "fail" }, `${e.file}: ${e.message}`));
  if (run.summary) {
    const s = run.summary;
    body.push(h("div", { class: s.status === "passed" ? "pass" : "fail" },
      s.status === "error" ? `ERROR during ${s.failedStage ?? "run"}: ${s.error ?? ""}` : `${s.status.toUpperCase()} · ${(s.durationMs / 1000).toFixed(2)}s`));
  } else if (!run.attempts.length) body.push(h("div", { class: "muted" }, run.currentStage ? `${run.currentStage}…` : "Queued…"));
  return h("div", {},
    h("h2", {}, `Run ${run.runId}`),
    h("div", { class: "stages" }, stages),
    h("div", { class: "log", id: "live-log" }, body),
  );
}

async function selectRun(runId) {
  store.selectedRun = runId;
  store.runDetail = null;
  render();
  try { store.runDetail = await rpc("runs.get", { runId }); } catch (e) { store.runDetail = { error: e.message }; }
  render();
}

function viewRuns() {
  const rows = store.runs.map((r) => h("tr", { class: `clickable ${r.runId === store.selectedRun ? "selected" : ""}`, onclick: () => selectRun(r.runId) },
    h("td", { class: "mono" }, r.runId),
    h("td", {}, new Date(r.startedAt).toLocaleString()),
    h("td", {}, h("span", { class: `badge ${r.status === "passed" ? "pass" : "fail"}` }, r.status)),
    h("td", {}, `${r.passed}/${r.tests}`),
    h("td", { class: "muted" }, `${(r.durationMs / 1000).toFixed(2)}s`),
  ));
  const d = store.runDetail;
  let detail = h("div", { class: "empty" }, "Select a run.");
  if (store.selectedRun && !d) detail = h("div", { class: "empty" }, "Loading…");
  if (d?.error) detail = h("div", { class: "fail" }, d.error);
  else if (d?.tests) {
    detail = h("div", { class: "log" },
      d.error ? h("div", { class: "fail" }, `ERROR during ${d.failedStage}: ${d.error}`) : null,
      d.tests.map((t) => h("div", {},
        h("div", {}, h("span", { class: t.status === "passed" ? "pass" : t.status === "skipped" ? "muted" : "fail" }, t.status === "passed" ? "✓ " : t.status === "skipped" ? "- " : "✗ "), t.name,
          t.attempts.length > 1 ? h("span", { class: "muted" }, ` (${t.passed}/${t.attempts.length}, ${Math.round(t.reliability * 100)}%)`) : null),
        t.correlations.map((c) => h("div", { class: "warn" }, `   ${c.description}`)),
        t.attempts.filter((a) => a.status !== "passed").slice(0, 3).map((a) => h("div", {},
          a.assertions.filter((x) => !x.passed).map((x) => h("div", { class: "fail" }, `   ${x.description}: expected ${JSON.stringify(x.expected)}, received ${JSON.stringify(x.received)}`)),
          a.error && !a.assertions.some((x) => !x.passed) ? h("div", { class: "fail" }, `   ${a.error}`) : null,
          a.artifactDir ? h("div", { class: "muted" }, `   artifacts: ${a.artifactDir}`) : null)),
      )),
      d.artifactDir ? h("div", { class: "muted" }, `results: ${d.artifactDir}`) : null,
    );
  }
  return h("div", {},
    h("h1", {}, "Runs"),
    h("div", { class: "split" },
      store.runs.length
        ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Run"), h("th", {}, "Started"), h("th", {}, "Status"), h("th", {}, "Passed"), h("th", {}, "Duration"))), h("tbody", {}, rows))
        : h("div", { class: "empty" }, "No runs yet."),
      detail),
  );
}

function summarize(payload) {
  return Object.entries(payload ?? {})
    .filter(([, v]) => v !== null && typeof v !== "object")
    .slice(0, 5)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}

async function selectEvent(e) {
  store.selectedEvent = e;
  store.trace = null;
  render();
  try { store.trace = (await rpc("events.trace", { eventId: e.id })).text; } catch (err) { store.trace = err.message; }
  render();
}

function eventRows() {
  const f = store.eventFilter.toLowerCase();
  const source = store.frozen ?? store.events;
  const list = f ? source.filter((e) => e.type.includes(f) || JSON.stringify(e.payload).toLowerCase().includes(f)) : source;
  return list.slice(-400).reverse().map((e) => h("tr", { class: `clickable ${store.selectedEvent?.id === e.id ? "selected" : ""}`, onclick: () => selectEvent(e) },
    h("td", { class: "mono muted" }, (e.timestamp / 1000).toFixed(3)),
    h("td", { class: "mono" }, e.type),
    h("td", { class: "mono muted" }, e.source ? `${e.source.type}:${e.source.id}` : ""),
    h("td", { class: "mono" }, summarize(e.payload)),
  ));
}

function renderEventsTableOnly() {
  const tbody = $("events-body");
  if (tbody) tbody.replaceChildren(...eventRows());
}

function viewEvents() {
  const filter = h("input", { placeholder: "filter (type or payload)", value: store.eventFilter,
    oninput: (ev) => { store.eventFilter = ev.target.value; renderEventsTableOnly(); } });
  const sel = store.selectedEvent;
  return h("div", {},
    h("h1", {}, "Events"),
    h("div", { class: "row" }, filter,
      h("button", { onclick: () => { store.paused = !store.paused; store.frozen = store.paused ? store.events.slice() : null; render(); } }, store.paused ? "Resume" : "Pause"),
      store.paused ? h("span", { class: "warn" }, "paused — new events are kept and shown on resume") : null,
      h("span", { class: "muted" }, `${store.events.length} shown (latest first)`)),
    h("div", { class: "split" },
      h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "t (s)"), h("th", {}, "Type"), h("th", {}, "Source"), h("th", {}, "Payload"))), h("tbody", { id: "events-body" }, eventRows())),
      sel ? h("div", {},
        h("h2", {}, sel.type),
        h("div", { class: "log" }, h("pre", {}, JSON.stringify(sel, null, 2))),
        h("h2", {}, "Causal chain"),
        h("div", { class: "log" }, h("pre", {}, store.trace ?? "Loading…")),
      ) : h("div", { class: "empty" }, "Select an event to see its payload and causal chain.")),
  );
}

function viewRuntime() {
  const g = store.state?.game;
  if (!g) return h("div", {}, h("h1", {}, "Runtime"), h("div", { class: "empty" }, "No state yet."));
  const players = Object.values(g.players);
  const devices = Object.values(g.devices);
  const probes = Object.entries(g.probes);
  const table = (heads, rows) => rows.length
    ? h("table", {}, h("thead", {}, h("tr", {}, heads.map((x) => h("th", {}, x)))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", { class: "mono" }, c ?? "—"))))))
    : h("div", { class: "muted" }, "None observed.");
  return h("div", {},
    h("h1", {}, "Runtime"),
    h("div", { class: "cards" }, card("Phase", g.phase), card("Round", g.round),
      ...Object.values(g.teams).map((t) => card(`Team ${t.id}`, t.score))),
    h("h2", {}, "Players"),
    table(["Player", "Team", "Status", "Health", "Shield", "Score", "Elims", "Deaths", "Areas"],
      players.map((p) => [p.id, p.team, p.alive ? "Alive" : "Eliminated", p.health, p.shield, p.score, p.eliminations, p.deaths, p.areas.join(", ")])),
    h("h2", {}, "Devices"),
    table(["Device", "Type", "State", "Enabled", "Owner", "Progress", "Triggers"],
      devices.map((d) => [d.id, d.type, d.state, String(d.enabled), d.owner !== undefined ? `Team ${d.owner}` : null, d.progress !== undefined ? `${d.progress}%` : null, d.triggerCount])),
    h("h2", {}, "Probes"),
    table(["Probe", "Value"], probes.map(([k, v]) => [k, JSON.stringify(v)])),
  );
}

async function selectRecording(id) {
  store.selectedRecording = id;
  store.recordingDetail = null;
  store.preview = null;
  render();
  try { store.recordingDetail = (await rpc("recordings.get", { id })).summary; } catch (e) { store.recordingDetail = { error: e.message }; }
  render();
}

async function previewTest(write) {
  const id = store.selectedRecording;
  if (!id) return;
  try {
    const r = await rpc("recordings.generate", { id, format: store.genFormat, counts: store.genCounts, write });
    store.preview = r.source;
    if (r.written) { toast(`Saved ${r.written}`); await loadTests(); }
  } catch (e) { toast(`Generate failed: ${e.message}`); }
  render();
}

async function startRecording() {
  await act("Start recording", async () => {
    if (!store.state?.session || store.state.session.status === "stopped") await rpc("session.start");
    await rpc("recording.start", { kind: store.recordKind, ...(store.recordName ? { name: store.recordName } : {}) });
  });
}

function command(cmd) {
  return act(cmd.type.replace(/_/g, " "), () => rpc("runtime.command", { command: cmd }));
}

function playground() {
  const s = store.state;
  const can = new Set(s?.commands ?? []);
  if (!can.has("spawn_player")) {
    return h("div", { class: "notice" }, "This transport cannot drive the game. Play in UEFN while recording; DevTools observes through the runtime log.");
  }
  const players = Object.values(s.game.players).map((p) => p.id);
  const devices = (s.devices ?? []).map((d) => d.id);
  const pg = store.pg;
  const bind = (key, num) => (e) => { pg[key] = num ? Number(e.target.value) : e.target.value; };
  const select = (key, options, label) => {
    if (!options.includes(pg[key])) pg[key] = options[0];
    return h("select", { onchange: bind(key), "aria-label": label }, options.map((o) => h("option", { value: o, selected: o === pg[key] }, o)));
  };
  if (!pg.pid || players.includes(pg.pid)) pg.pid = `player${players.length + 1}`;
  const pid = h("input", { placeholder: "player id", "aria-label": "new player id", value: pg.pid, size: 10, oninput: bind("pid") });
  const team = h("input", { type: "number", min: 1, value: pg.team, title: "team", "aria-label": "team", oninput: bind("team", true) });
  const who = select("who", players.length ? players : ["(spawn a player)"], "player");
  const where = select("where", devices.length ? devices : ["(no devices)"], "area");
  const by = select("by", ["(nobody)", ...players], "eliminated by");
  const dmg = h("input", { type: "number", min: 1, value: pg.dmg, title: "damage", "aria-label": "damage amount", oninput: bind("dmg", true) });
  const needPlayer = !players.length;
  return h("div", {},
    h("div", { class: "row" },
      h("button", { onclick: () => command({ type: "start_game" }) }, "Start game"),
      h("button", { onclick: () => command({ type: "end_game" }) }, "End game")),
    h("div", { class: "row" }, "Spawn ", pid, " on team ", team,
      h("button", { onclick: () => command({ type: "spawn_player", player: pg.pid, team: pg.team }) }, "Spawn")),
    h("div", { class: "row" }, who, " → ", where,
      h("button", { disabled: needPlayer, onclick: () => command({ type: "teleport", player: pg.who, location: pg.where }) }, "Enter area"),
      h("button", { disabled: needPlayer, onclick: () => command({ type: "leave_area", player: pg.who, area: pg.where }) }, "Leave"),
      h("button", { disabled: needPlayer, onclick: () => command({ type: "damage_player", player: pg.who, amount: pg.dmg }) }, "Damage"), dmg,
      h("button", { disabled: needPlayer, onclick: () => command({ type: "eliminate_player", player: pg.who, ...(pg.by !== "(nobody)" ? { by: pg.by } : {}) }) }, "Eliminate"), " by ", by),
  );
}

function viewRecord() {
  const s = store.state;
  const active = s?.recording;
  const nameInput = h("input", { placeholder: "recording name", value: store.recordName, oninput: (e) => { store.recordName = e.target.value; } });
  const kind = h("select", { onchange: (e) => { store.recordKind = e.target.value; } },
    h("option", { value: "scenario", selected: store.recordKind === "scenario" }, "Scenario → test"),
    h("option", { value: "bug", selected: store.recordKind === "bug" }, "Bug report"));
  const controls = active
    ? h("div", { class: "row" },
        h("span", { class: "fail" }, `● Recording "${active.name}" (${active.kind})`),
        h("span", { class: "muted" }, `since ${new Date(active.startedAt).toLocaleTimeString()}`),
        h("button", { class: "primary", onclick: () => act("Stop recording", () => rpc("recording.stop")) }, "Stop recording"))
    : h("div", { class: "row" }, nameInput, kind, h("button", { class: "primary", onclick: startRecording }, "Start recording"));

  const rows = store.recordings.map((r) => h("tr", { class: `clickable ${r.id === store.selectedRecording ? "selected" : ""}`, onclick: () => selectRecording(r.id) },
    h("td", {}, r.name, r.kind === "bug" ? h("span", { class: "badge fail" }, " bug") : null),
    h("td", { class: "muted" }, new Date(r.startedAt).toLocaleString()),
    h("td", {}, `${(r.durationMs / 1000).toFixed(1)}s`),
    h("td", {}, r.events),
    h("td", { class: r.anomalies.length ? "warn" : "muted" }, r.anomalies.length || "—")));

  const d = store.recordingDetail;
  let detail = h("div", { class: "empty" }, "Select a recording.");
  if (store.selectedRecording && !d) detail = h("div", { class: "empty" }, "Loading…");
  else if (d?.error) detail = h("div", { class: "fail" }, d.error);
  else if (d) {
    const format = h("select", { onchange: (e) => { store.genFormat = e.target.value; } },
      h("option", { value: "yaml", selected: store.genFormat === "yaml" }, "YAML"),
      h("option", { value: "ts", selected: store.genFormat === "ts" }, "TypeScript"));
    const counts = h("input", { type: "checkbox", checked: store.genCounts, onchange: (e) => { store.genCounts = e.target.checked; } });
    detail = h("div", {},
      h("div", { class: "log" },
        h("div", {}, h("b", {}, d.kind === "bug" ? "Bug Recording " : "Recording "), d.id),
        h("div", {}, `Duration          ${(d.durationMs / 1000).toFixed(1)} seconds`),
        h("div", {}, `Events            ${d.events}`),
        h("div", {}, `Relevant devices  ${d.devices.length}  ${d.devices.join(", ")}`),
        h("div", {}, `Players           ${d.players.length}  ${d.players.join(", ")}`),
        h("div", {}, " "),
        d.anomalies.length ? [h("div", {}, "Potential anomalies"), d.anomalies.map((a) => h("div", { class: a.severity === "error" ? "fail" : "warn" },
          `  [${a.severity}] ${a.message}${a.traceIds.length ? `  (traces ${a.traceIds.join(", ")})` : ""}`))] : h("div", { class: "pass" }, "No anomalies detected.")),
      h("div", { class: "row" }, format, h("label", { class: "muted" }, counts, " exact event counts"),
        h("button", { onclick: () => previewTest(false) }, "Preview test"),
        h("button", { class: "primary", onclick: () => previewTest(true) }, "Save to Tests")),
      store.preview ? h("div", { class: "log" }, h("pre", {}, store.preview)) : null);
  }

  return h("div", {},
    h("h1", {}, "Record"),
    h("p", { class: "muted" }, "Play while recording. Actions become test steps; the final observed state becomes assertions."),
    controls,
    h("h2", {}, "Simulator controls"),
    playground(),
    h("h2", {}, "Recordings"),
    h("div", { class: "split" },
      store.recordings.length
        ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Recorded"), h("th", {}, "Duration"), h("th", {}, "Events"), h("th", {}, "Anomalies"))), h("tbody", {}, rows))
        : h("div", { class: "empty" }, "No recordings yet."),
      detail));
}

async function loadDoctor() {
  store.doctorLoading = true;
  if (store.view === "doctor") render();
  try { store.doctor = await rpc("doctor.run"); } catch (e) { store.doctor = { error: e.message }; }
  store.doctorLoading = false;
  if (store.view === "doctor") render();
}

function viewDoctor() {
  const d = store.doctor;
  if (!d && !store.doctorLoading) loadDoctor();
  const head = h("div", { class: "row" },
    h("button", { onclick: loadDoctor, disabled: store.doctorLoading }, store.doctorLoading ? "Analysing…" : "Re-run"),
    h("label", { class: "muted" }, "show ",
      h("select", { "aria-label": "minimum severity", onchange: (e) => { store.doctorMin = e.target.value; render(); } },
        ["info", "warning", "error"].map((v) => h("option", { value: v, selected: v === store.doctorMin }, v === "info" ? "everything" : `${v}s and worse`)))));
  if (!d) return h("div", {}, h("h1", {}, "Doctor"), head, h("div", { class: "empty" }, "Analysing project…"));
  if (d.error) return h("div", {}, h("h1", {}, "Doctor"), head, h("div", { class: "fail" }, d.error));
  const rank = { error: 3, warning: 2, info: 1 };
  const shown = d.findings.filter((f) => rank[f.severity] >= rank[store.doctorMin]);
  const scoreClass = (n) => (n === null ? "muted" : n >= 90 ? "pass" : n >= 70 ? "warn" : "fail");
  return h("div", {},
    h("h1", {}, "Doctor"),
    h("div", { class: "cards" },
      d.scores.map((s) => h("div", { class: "card", title: s.reason ?? "" },
        h("div", { class: "label" }, s.label),
        h("div", { class: `value ${scoreClass(s.score)}` }, s.score === null ? "n/a" : s.score),
        s.reason ? h("div", { class: "label" }, s.reason) : null))),
    h("div", { class: "row" },
      h("span", { class: `badge ${d.counts.error ? "fail" : ""}` }, `${d.counts.error} critical`),
      h("span", { class: "badge" }, `${d.counts.warning} warnings`),
      h("span", { class: "badge" }, `${d.counts.info} info`),
      d.failed ? h("span", { class: "fail" }, `fails at fail_on: ${d.failOn}`) : h("span", { class: "pass" }, `passes fail_on: ${d.failOn}`)),
    head,
    shown.length
      ? h("table", { class: "findings" }, h("thead", {}, h("tr", {}, h("th", {}, "Rule"), h("th", {}, "Severity"), h("th", {}, "Where"), h("th", {}, "Finding"))),
          h("tbody", {}, shown.map((f) => h("tr", {},
            h("td", { class: "mono" }, f.ruleId),
            h("td", {}, h("span", { class: `badge ${f.severity === "error" ? "fail" : ""}` }, f.severity)),
            h("td", { class: "mono muted" }, f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "—"),
            h("td", {}, h("div", {}, f.message, f.heuristic ? h("span", { class: "muted" }, "  (heuristic)") : null),
              (f.detail ?? []).map((x) => h("div", { class: "muted mono" }, x)))))))
      : h("div", { class: "empty" }, "No findings at this level."),
    h("p", { class: "muted" }, 'Suppress with "# devtools-ignore RULE-ID" on or above the line, or doctor.rules.RULE-ID: off in the config.'));
}

const VIEWS = { overview: viewOverview, doctor: viewDoctor, record: viewRecord, tests: viewTests, runs: viewRuns, events: viewEvents, runtime: viewRuntime };

function render() {
  const main = $("main");
  const log = $("live-log");
  const stick = log ? log.scrollTop + log.clientHeight >= log.scrollHeight - 20 : true;
  main.replaceChildren((VIEWS[store.view] ?? viewOverview)());
  const newLog = $("live-log");
  if (newLog && stick) newLog.scrollTop = newLog.scrollHeight;
  renderChrome();
}

function navigate(view) {
  if (!VIEWS[view]) view = "overview";
  store.view = view;
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  render();
}

window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));

async function boot() {
  if (!token) {
    $("main").replaceChildren(h("div", { class: "notice" },
      h("b", {}, "Not authorized. "), "Open the dashboard URL printed by ", h("span", { class: "mono" }, "uefn daemon"), " (it carries an access token)."));
    return;
  }
  connectStream();
  await Promise.all([loadTests(), loadRuns(), loadEvents(), loadRecordings(), (async () => { try { store.state = await rpc("state.get"); } catch {} })()]);
  navigate(location.hash.slice(1) || "overview");
}
boot();
