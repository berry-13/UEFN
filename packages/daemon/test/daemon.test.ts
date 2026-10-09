import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevToolsEngine } from "@uefn-devtools/core";
import { DaemonClient, DevToolsDaemon, daemonInfoPath, readDaemonInfo, type StreamMessage } from "@uefn-devtools/daemon";

const TEST_YAML = `name: Capture A
setup:
  - start_game
steps:
  - enter: { player: p1, area: A }
assert:
  - team: { id: 1, score: 50 }
`;

async function project() {
  const dir = await mkdtemp(join(tmpdir(), "uefn-devtools-daemon-"));
  await writeFile(
    join(dir, "uefn-devtools.config.yaml"),
    "simulated:\n  time_scale: 100\n  boot_ms: 100\n  devices:\n    - id: A\n      capture_time_ms: 1000\n",
  );
  await mkdir(join(dir, "Tests"));
  await writeFile(join(dir, "Tests", "capture.test.yaml"), TEST_YAML);
  return dir;
}

async function start(options: { staticDir?: string } = {}) {
  const dir = await project();
  const engine = await DevToolsEngine.open({ cwd: dir });
  const daemon = new DevToolsDaemon({ engine, ...options });
  const info = await daemon.start();
  const client = DaemonClient.fromInfo(info, "test-client");
  const close = async () => {
    await daemon.stop();
    await engine.close();
  };
  return { dir, engine, daemon, info, client, close };
}

/** Raw request so the Host header can be forged (fetch does not allow it). */
function raw(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("rejects missing or wrong tokens and foreign Host headers", async () => {
  const { info, close } = await start();
  try {
    const url = `http://127.0.0.1:${info.port}`;
    assert.equal((await fetch(`${url}/api/status`)).status, 401);
    assert.equal((await fetch(`${url}/api/status`, { headers: { authorization: "Bearer nope" } })).status, 401);
    // The query token is accepted on the stream only.
    assert.equal((await fetch(`${url}/api/status?token=${info.token}`)).status, 401);
    const rebinding = await raw(info.port, "/api/status", { host: "evil.example:80", authorization: `Bearer ${info.token}` });
    assert.equal(rebinding.status, 403);
    const local = await raw(info.port, "/api/status", { host: `localhost:${info.port}`, authorization: `Bearer ${info.token}` });
    assert.equal(local.status, 200);
    assert.equal((await fetch(`${url}/api/nope`, { headers: { authorization: `Bearer ${info.token}` } })).status, 404);
  } finally {
    await close();
  }
});

test("daemon.json is 0600, describes the daemon and is removed on stop", async () => {
  const { dir, info, client, close } = await start();
  const path = daemonInfoPath(dir);
  const onDisk = await readDaemonInfo(dir);
  assert.equal(onDisk?.port, info.port);
  assert.equal(onDisk?.pid, process.pid);
  assert.equal(onDisk?.stale, false);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  const status = await client.status();
  assert.equal(status.adapter, "simulated");
  assert.equal(status.session, null);
  assert.equal(status.events, 0);
  await close();
  await assert.rejects(stat(path));
});

test("stale daemon.json is detected and replaced", async () => {
  const dir = await project();
  await mkdir(join(dir, ".devtools"));
  // A pid far above any real pid_max: certainly not running.
  await writeFile(daemonInfoPath(dir), JSON.stringify({ pid: 2 ** 30, port: 1, token: "x", root: dir, startedAt: 0, version: "0" }));
  const stale = await readDaemonInfo(dir);
  assert.equal(stale?.stale, true);
  await assert.rejects(DaemonClient.fromRoot(dir), /stale/);

  const engine = await DevToolsEngine.open({ cwd: dir });
  const daemon = new DevToolsDaemon({ engine });
  await daemon.start();
  assert.equal((await readDaemonInfo(dir))?.stale, false);
  // A live daemon blocks a second one for the same project.
  await assert.rejects(new DevToolsDaemon({ engine }).start(), /already running/);
  const client = await DaemonClient.fromRoot(dir);
  assert.equal((await client.status()).daemon.pid, process.pid);
  await daemon.stop();
  await engine.close();
});

test("runs tests through the API, streams events, time travel and trace", async () => {
  const { dir, info, client, close } = await start();
  try {
    const listed = await client.tests();
    assert.deepEqual(listed.tests.map((t) => t.id), ["capture-a"]);

    const messages: StreamMessage[] = [];
    const abort = new AbortController();
    let opened!: () => void;
    const open = new Promise<void>((r) => (opened = r));
    let finished!: () => void;
    const done = new Promise<void>((r) => (finished = r));
    const streaming = client.stream(
      (m) => {
        messages.push(m);
        if (m.event === "runner" && m.data.kind === "done") finished();
      },
      { signal: abort.signal, onOpen: () => opened() },
    );
    await open;

    const summary = await client.runTests({ filter: "capture" });
    assert.equal(summary.status, "passed", JSON.stringify(summary.error ?? summary.tests));

    // The session is shared: it stays up after the run.
    const status = await client.status();
    assert.ok(status.session && status.session.status !== "stopped");
    assert.equal(status.runtimeReady, true);
    assert.ok(status.events > 0);

    await done;
    abort.abort();
    await streaming;
    const names = new Set(messages.map((m) => m.event));
    assert.ok(names.has("runtime") && names.has("runner") && names.has("session"), [...names].join(","));
    assert.ok(messages.some((m) => m.event === "session" && m.data.runtimeReady));
    const runtime = messages.filter((m) => m.event === "runtime");
    assert.ok(runtime.length > 0);
    assert.equal(runtime[0]!.id, "0");

    const scores = await client.events({ type: "ScoreChanged" });
    assert.equal(scores.events.length, 1);
    const score = scores.events[0]!;
    const paged = await client.events({ limit: 2 });
    assert.equal(paged.events.length, 2);
    assert.equal(paged.nextIndex, 2);
    assert.equal(paged.size, status.events);

    const trace = await client.trace(score.id);
    assert.match(trace.text, /capture\.completed/);
    assert.equal(trace.ancestry.at(-1), score.id);
    await assert.rejects(client.trace("missing"), /unknown event/);

    // Time travel: just before the score event the team has nothing; at it, 50.
    const before = await client.stateAt(score.index - 1);
    const at = await client.stateAt(score.index);
    assert.equal(before.state.teams["1"]?.score ?? 0, 0);
    assert.equal(at.state.teams["1"]?.score, 50);
    assert.equal(at.timestamp, score.timestamp);
    await assert.rejects(client.stateAt(status.events), /out of range/);

    const audit = await readFile(join(dir, ".devtools", "audit.log"), "utf8");
    assert.match(audit, /"actor":"test-client","action":"daemon.tests.run","outcome":"ok"/);

    // EventSource-style access: token in the query string, replay from an index.
    const res = await fetch(`http://127.0.0.1:${info.port}/api/stream?token=${info.token}&fromIndex=${score.index}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("event: session")) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, new RegExp(`id: ${score.index}\\nevent: runtime`));
    await reader.cancel();

    await client.stopSession();
    assert.equal((await client.status()).session?.status, "stopped");
  } finally {
    await close();
  }
});

test("serves static files without escaping the static root", async () => {
  const dir = await project();
  const site = join(dir, "site");
  await mkdir(site);
  await writeFile(join(site, "index.html"), "<!doctype html><title>ui</title>");
  await writeFile(join(site, "app.js"), "export {};");
  await writeFile(join(dir, "secret.txt"), "secret");
  const { info, close } = await start({ staticDir: site });
  try {
    const auth = { authorization: `Bearer ${info.token}` };
    const url = `http://127.0.0.1:${info.port}`;
    const index = await fetch(`${url}/`, { headers: auth });
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    const js = await fetch(`${url}/app.js`, { headers: auth });
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const escape = await raw(info.port, "/../secret.txt", { host: "127.0.0.1", ...auth });
    assert.equal(escape.status, 404);
    const encoded = await raw(info.port, "/%2e%2e/secret.txt", { host: "127.0.0.1", ...auth });
    assert.equal(encoded.status, 404);
    // Static assets load without the token; the API still needs it.
    const anonymous = await fetch(`${url}/app.js`);
    assert.equal(anonymous.status, 200);
    assert.match(anonymous.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal((await fetch(`${url}/api/status`)).status, 401);
    assert.equal((await fetch(`${url}/api/stream`)).status, 401);
    assert.equal((await raw(info.port, "/../secret.txt", { host: "127.0.0.1" })).status, 404);
    assert.equal((await raw(info.port, "/index.html", { host: "evil.example" })).status, 403);
    assert.equal((await fetch(`${url}/api/status`, { headers: auth }).then((r) => r.json())).daemon.ui, true);
    assert.equal(info.ui, true);
  } finally {
    await close();
  }
});
