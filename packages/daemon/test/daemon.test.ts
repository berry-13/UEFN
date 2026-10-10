import assert from "node:assert/strict";
import { request, type IncomingMessage } from "node:http";
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevToolsEngine } from "@uefn-devtools/core";
import { DaemonClient, DevToolsDaemon, daemonInfoPath, daemonLockPath, probeDaemon, readDaemonInfo, type StreamMessage } from "@uefn-devtools/daemon";

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

async function start(options: { staticDir?: string; onShutdown?: () => void } = {}) {
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
    // The simulator keeps emitting perf.sample events, so the log only grows.
    assert.ok(paged.size >= status.events);

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
    await assert.rejects(client.stateAt(1_000_000), /out of range/);

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

    // Launch tickets: minting needs the token; each ticket is traded once.
    assert.equal((await fetch(`${url}/api/ui/ticket`, { method: "POST" })).status, 401);
    const { ticket } = await fetch(`${url}/api/ui/ticket`, { method: "POST", headers: auth }).then((r) => r.json());
    const exchange = (t: string) =>
      fetch(`${url}/api/ui/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: t }) });
    const first = await exchange(ticket);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).token, info.token);
    assert.equal((await exchange(ticket)).status, 401);
    assert.equal((await exchange("forged")).status, 401);
  } finally {
    await close();
  }
});

test("a static file that cannot be opened yields a 500 and the daemon survives", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const dir = await project();
  const site = join(dir, "site");
  await mkdir(site);
  await writeFile(join(site, "index.html"), "<!doctype html>");
  await writeFile(join(site, "locked.js"), "export {};");
  await chmod(join(site, "locked.js"), 0o000);
  const { info, close } = await start({ staticDir: site });
  try {
    const url = `http://127.0.0.1:${info.port}`;
    const locked = await fetch(`${url}/locked.js`);
    assert.equal(locked.status, 500);
    await locked.text();
    assert.equal((await fetch(`${url}/index.html`)).status, 200);
  } finally {
    await close();
  }
});

test("stream reconnect prefers Last-Event-ID over fromIndex", async () => {
  const { engine, info, client, close } = await start();
  try {
    await client.runTests({ filter: "capture" });
    const last = engine.events.size - 2;
    assert.ok(last >= 1);
    const res = await fetch(`http://127.0.0.1:${info.port}/api/stream?token=${info.token}&fromIndex=0`, {
      headers: { "last-event-id": String(last) },
    });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("event: session")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    // Replay starts right after Last-Event-ID (not at fromIndex=0) and stays in
    // order; live perf samples may follow, since the session keeps running.
    assert.equal(ids[0], last + 1);
    assert.deepEqual(ids, ids.map((_, i) => last + 1 + i));
  } finally {
    await close();
  }
});

test("shutdown waits for an in-progress run", async () => {
  let stopped = false;
  const { client, close } = await start({ onShutdown: () => void (stopped = true) });
  try {
    const run = client.runTests({ filter: "capture" });
    await new Promise((r) => setTimeout(r, 50));
    const shutdown = client.shutdown();
    const summary = await run;
    assert.equal(summary.status, "passed", JSON.stringify(summary.error ?? summary.tests));
    await shutdown;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stopped, true);
  } finally {
    await close();
  }
});

test("two concurrent starts for one project: exactly one wins, and the lock is released on stop", async () => {
  const dir = await project();
  const engine = await DevToolsEngine.open({ cwd: dir });
  const a = new DevToolsDaemon({ engine });
  const b = new DevToolsDaemon({ engine });
  const results = await Promise.allSettled([a.start(), b.start()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const winner = results[0].status === "fulfilled" ? a : b;
  await winner.stop();
  await assert.rejects(stat(daemonLockPath(dir)));
  const again = new DevToolsDaemon({ engine });
  await again.start();
  await again.stop();
  await engine.close();
});

test("a lock left by a dead process is taken over", async () => {
  const dir = await project();
  await mkdir(join(dir, ".devtools"));
  await writeFile(daemonLockPath(dir), JSON.stringify({ pid: 2 ** 30, nonce: "x" }));
  const engine = await DevToolsEngine.open({ cwd: dir });
  const daemon = new DevToolsDaemon({ engine });
  await daemon.start();
  await daemon.stop();
  await engine.close();
});

test("daemon.json whose pid runs but whose daemon does not answer is not a live daemon", async () => {
  const dir = await project();
  await mkdir(join(dir, ".devtools"));
  // Our own pid is certainly alive; nothing listens on port 1.
  await writeFile(daemonInfoPath(dir), JSON.stringify({ pid: process.pid, port: 1, token: "x", root: dir, startedAt: 0, version: "0" }));
  assert.equal(await probeDaemon({ port: 1, token: "x" }), false);
  const engine = await DevToolsEngine.open({ cwd: dir });
  const daemon = new DevToolsDaemon({ engine });
  const info = await daemon.start();
  assert.equal(await probeDaemon(info), true);
  await daemon.stop();
  await engine.close();
});

test("a start that fails after listening tears everything down", async () => {
  const dir = await project();
  // A directory where daemon.json goes makes the final rename fail.
  await mkdir(join(dir, ".devtools", "daemon.json"), { recursive: true });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const daemon = new DevToolsDaemon({ engine });
  await assert.rejects(daemon.start());
  assert.equal((daemon as unknown as { server: { listening: boolean } }).server.listening, false);
  assert.equal(daemon.port, 0);
  await assert.rejects(stat(daemonLockPath(dir)));
  await engine.close();
});

test("default shutdown answers before it stops, and refuses mutations meanwhile", async () => {
  const { dir, engine, client, close } = await start();
  try {
    // Hold the session lock with a compile that finishes only when released.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const compile = engine.compile.bind(engine);
    engine.compile = async () => {
      await gate;
      return compile();
    };
    const held = client.compile();
    while (!(await client.status()).busy) await new Promise((r) => setTimeout(r, 5));
    const shutdown = client.shutdown();
    // An invalid run body answers 400 while the daemon is open and 503 once it is closing.
    const probe = () => client.runTests({ repeat: 0 }).then(() => 200, (e: { status: number }) => e.status);
    let code: number;
    while ((code = await probe()) === 400) await new Promise((r) => setTimeout(r, 5));
    assert.equal(code, 503);
    await assert.rejects(client.compile(), /shutting down/);
    release();
    assert.equal((await held).success, true);
    assert.deepEqual(await shutdown, { stopping: true });
    for (let i = 0; i < 100 && (await readDaemonInfo(dir)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await readDaemonInfo(dir), undefined);
  } finally {
    await close();
  }
});

test("runs exact test ids through the API", async () => {
  const { dir, client, close } = await start();
  try {
    await writeFile(join(dir, "Tests", "capture-twice.test.yaml"), TEST_YAML.replace("name: Capture A", "name: Capture A twice"));
    const summary = await client.runTests({ ids: ["capture-a"] });
    assert.equal(summary.status, "passed", JSON.stringify(summary.error ?? summary.tests));
    assert.deepEqual(summary.tests.map((t) => t.id), ["capture-a"]);
  } finally {
    await close();
  }
});

test("a stream that stops reading is dropped instead of buffered without bound", async () => {
  const dir = await project();
  const engine = await DevToolsEngine.open({ cwd: dir });
  const daemon = new DevToolsDaemon({ engine, streamBufferLimit: 64 * 1024 });
  const info = await daemon.start();
  const client = DaemonClient.fromInfo(info);
  try {
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: info.port, path: `/api/stream?token=${info.token}` }, resolve);
      req.on("error", reject);
      req.end();
    });
    res.pause();
    res.on("error", () => {});
    while ((await client.status()).daemon.streams === 0) await new Promise((r) => setTimeout(r, 5));
    const chunk = `: ${"x".repeat(1024 * 1024)}\n\n`;
    const broadcast = (daemon as unknown as { broadcastRaw(chunk: string): void }).broadcastRaw.bind(daemon);
    // Kernel socket buffers absorb some data first; the daemon must give up well before 256 MiB.
    for (let i = 0; i < 256 && (await client.status()).daemon.streams > 0; i++) {
      broadcast(chunk);
      await new Promise((r) => setImmediate(r));
    }
    assert.equal((await client.status()).daemon.streams, 0);
    res.destroy();
  } finally {
    await daemon.stop();
    await engine.close();
  }
});

test("aborting a client stream before its headers arrive resolves quietly", async () => {
  const { client, close } = await start();
  try {
    const controller = new AbortController();
    controller.abort();
    await client.stream(() => {}, { signal: controller.signal });
  } finally {
    await close();
  }
});
