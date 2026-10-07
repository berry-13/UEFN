import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DevToolsEngine } from "@uefn-devtools/core";
import { DaemonClient, DaemonRpcError, daemonInfoPath, startDaemon } from "@uefn-devtools/daemon";

const YAML = `name: Capture A
setup:
  - start_game
steps:
  - enter: { player: p1, area: A }
assert:
  - team: { id: 1, score: 50 }
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "uefn-daemon-"));
  await writeFile(
    join(dir, "uefn-devtools.config.yaml"),
    "simulated:\n  time_scale: 100\n  boot_ms: 100\n  devices:\n    - id: A\n      capture_time_ms: 1000\n",
  );
  await mkdir(join(dir, "Tests"));
  await writeFile(join(dir, "Tests", "a.test.yaml"), YAML);
  const engine = await DevToolsEngine.open({ cwd: dir });
  const daemon = await startDaemon({ engine, port: 0 });
  return { dir, engine, daemon, client: new DaemonClient(daemon.info) };
}

test("rpc run streams progress and lands in run history", async () => {
  const { dir, engine, daemon, client } = await setup();
  try {
    const info = JSON.parse(await readFile(daemonInfoPath(dir), "utf8"));
    assert.equal(info.token, daemon.info.token);
    assert.equal((await stat(daemonInfoPath(dir))).mode & 0o777, 0o600);
    assert.equal((await DaemonClient.discover(dir))?.info.url, daemon.info.url);

    const abort = new AbortController();
    const stream = client.stream(abort.signal);
    assert.equal((await stream.next()).value?.channel, "hello");
    const { runId } = await client.call("tests.run", {});
    const kinds: string[] = [];
    let sawRuntime = false;
    for await (const m of stream) {
      if (m.channel === "runtime") sawRuntime = true;
      if (m.channel !== "activity" || m.runId !== runId) continue;
      const data = m.data as { kind: string; summary?: { status: string } };
      kinds.push(data.kind);
      if (data.kind === "done") {
        assert.equal(data.summary?.status, "passed");
        break;
      }
    }
    abort.abort();
    assert.ok(sawRuntime, "runtime events are streamed");
    assert.ok(kinds.includes("attempt") && kinds.includes("test"));

    const history = await client.call("runs.list", {});
    assert.equal(history.runs[0].runId, runId);
    const detail = await client.call("runs.get", { runId });
    assert.equal(detail.tests[0].status, "passed");
    const state = await client.call("state.get", {});
    assert.equal(state.game.teams["1"].score, 50);
    await assert.rejects(client.call("runs.get", { runId: "../../etc" }), DaemonRpcError);
  } finally {
    await daemon.close();
    await engine.close();
  }
  await assert.rejects(stat(daemonInfoPath(dir)), "info file removed on close");
});

test("rejects missing tokens, foreign hosts and foreign origins", async () => {
  const { engine, daemon } = await setup();
  const { url, token, port } = daemon.info;
  const rpc = (headers: Record<string, string>) =>
    fetch(`${url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "project.get" }),
    });
  try {
    assert.equal((await rpc({})).status, 401);
    assert.equal((await rpc({ authorization: "Bearer wrong" })).status, 401);
    assert.equal((await rpc({ authorization: `Bearer ${token}`, origin: "http://evil.example" })).status, 403);
    assert.equal((await rpc({ authorization: `Bearer ${token}`, origin: `http://localhost:${port}` })).status, 200);
    assert.equal((await fetch(`${url}/stream`)).status, 401);
    assert.equal((await fetch(`${url}/mcp`, { method: "POST" })).status, 401);
    // Static dashboard needs no token but must not leak data or traverse.
    assert.equal((await fetch(`${url}/`)).status, 200);
    assert.equal((await fetch(`${url}/..%2Fpackage.json`)).status, 404);
  } finally {
    await daemon.close();
    await engine.close();
  }
});

test("MCP over HTTP shares the daemon's engine", async () => {
  const { engine, daemon, client } = await setup();
  const mcp = new Client({ name: "agent", version: "0" });
  try {
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${daemon.info.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${daemon.info.token}` } },
      }),
    );
    const r = await mcp.callTool({ name: "uefn_run_tests", arguments: {} });
    const summary = JSON.parse((r.content as { text: string }[])[0]!.text);
    assert.equal(summary.status, "passed");
    // The run the agent made is visible to every other client.
    const history = await client.call("runs.list", {});
    assert.equal(history.runs.length, 1);
    const state = await client.call("state.get", {});
    assert.ok(state.eventCount > 0);
  } finally {
    await mcp.close();
    await daemon.close();
    await engine.close();
  }
});

test("record via RPC with simulator commands, then generate and run the test", async () => {
  const { engine, daemon, client } = await setup();
  try {
    await client.call("session.start", {});
    const rec = await client.call("recording.start", { name: "Capture via RPC" });
    for (const command of [
      { type: "start_game" },
      { type: "spawn_player", player: "p1", team: 1 },
      { type: "teleport", player: "p1", location: "A" },
    ]) await client.call("runtime.command", { command });
    await engine.waitForEvent({ type: "score.changed" }, { timeoutMs: 10_000, fromIndex: 0 });
    const stopped = await client.call("recording.stop", {});
    assert.equal(stopped.summary.id, rec.id);
    assert.deepEqual(stopped.summary.anomalies, []);

    const listed = await client.call("recordings.list", {});
    assert.equal(listed.recordings[0].id, rec.id);
    const gen = await client.call("recordings.generate", { id: rec.id, write: true });
    assert.match(gen.written, /^Tests\/capture-via-rpc\.recorded\.test\.yaml$/);
    await assert.rejects(client.call("runtime.command", { command: { type: "fly" } }), DaemonRpcError);

    const abort = new AbortController();
    const stream = client.stream(abort.signal);
    await stream.next();
    const { runId } = await client.call("tests.run", { filter: "capture-via-rpc", compile: false });
    for await (const m of stream) {
      const data = m.channel === "activity" && m.runId === runId ? (m.data as { kind: string; summary?: { status: string } }) : undefined;
      if (data?.kind === "done") {
        assert.equal(data.summary?.status, "passed");
        break;
      }
    }
    abort.abort();
  } finally {
    await daemon.close();
    await engine.close();
  }
});

test("doctor over RPC", async () => {
  const { engine, daemon, client } = await setup();
  try {
    const report = await client.call("doctor.run", {});
    assert.equal(report.scores.find((s: { category: string }) => s.category === "tests").score, 100);
    assert.equal(report.failed, false);
  } finally {
    await daemon.close();
    await engine.close();
  }
});

test("info file: tightened if it already existed, left alone if another daemon took it over", async () => {
  const { chmod: chmodFile, mkdir: mk, writeFile: write } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "uefn-daemon-"));
  await writeFile(join(dir, "uefn-devtools.config.yaml"), "simulated:\n  boot_ms: 10\n");
  await mk(join(dir, ".devtools"));
  await write(daemonInfoPath(dir), "{}");
  await chmodFile(daemonInfoPath(dir), 0o644);
  const engine = await DevToolsEngine.open({ cwd: dir });
  const daemon = await startDaemon({ engine, port: 0 });
  assert.equal((await stat(daemonInfoPath(dir))).mode & 0o777, 0o600);
  // A newer daemon for the same project overwrote the file.
  const newer = { ...daemon.info, pid: daemon.info.pid + 1, token: "newer-daemon-token-xxxxxxxxxxxx" };
  await write(daemonInfoPath(dir), JSON.stringify(newer));
  await daemon.close();
  await engine.close();
  assert.equal(JSON.parse(await readFile(daemonInfoPath(dir), "utf8")).token, newer.token);
});

test("discovery ignores a daemon that serves a different project", async () => {
  const { engine, daemon, dir: other } = await setup();
  try {
    const { mkdir: mk, writeFile: write } = await import("node:fs/promises");
    const mine = await mkdtemp(join(tmpdir(), "uefn-daemon-"));
    await mk(join(mine, ".devtools"));
    await write(daemonInfoPath(mine), JSON.stringify(daemon.info)); // stale file pointing at the other daemon
    assert.equal(await DaemonClient.discover(mine), undefined);
    assert.ok(await DaemonClient.discover(other));
  } finally {
    await daemon.close();
    await engine.close();
  }
});

test("runtime commands queue behind a run holding the session", async () => {
  const { engine, daemon, client } = await setup();
  try {
    await client.call("session.start", {});
    let release!: () => void;
    const held = engine.exclusive(() => new Promise<void>((r) => (release = r)));
    const sent = client.call("runtime.command", { command: { type: "start_game" } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(engine.state.phase, "idle", "command ran while the session was held");
    release();
    await held;
    await sent;
    await engine.waitForEvent({ type: "game.started" }, { timeoutMs: 5000, fromIndex: 0 });
  } finally {
    await daemon.close();
    await engine.close();
  }
});
