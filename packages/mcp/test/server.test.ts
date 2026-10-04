import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DevToolsEngine } from "@uefn-devtools/core";
import { createDevToolsMcpServer } from "@uefn-devtools/mcp";

async function connect(mode: "read_only" | "development" | "full_access") {
  const dir = await mkdtemp(join(tmpdir(), "uefn-devtools-mcp-"));
  await writeFile(
    join(dir, "uefn-devtools.config.yaml"),
    "simulated:\n  time_scale: 100\n  boot_ms: 100\n  devices:\n    - id: A\n      capture_time_ms: 1000\n",
  );
  await mkdir(join(dir, "Tests"));
  const engine = await DevToolsEngine.open({ cwd: dir });
  const server = createDevToolsMcpServer({ engine, mode, actor: "test-agent" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    return { isError: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
  };
  return { dir, engine, client, call };
}

const TEST_YAML = `name: Agent written
setup:
  - start_game
steps:
  - enter: { player: p1, area: A }
assert:
  - team: { id: 1, score: 50 }
`;

test("agent loop: create test, run it, read verdict", async () => {
  const { dir, engine, client, call } = await connect("full_access");
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("uefn_run_test") && tools.includes("uefn_compile_verse"));

  const created = await call("uefn_create_test", { file_name: "agent", yaml: TEST_YAML });
  assert.equal(created.isError, false, created.text);
  const listed = await call("uefn_list_tests");
  assert.equal(listed.json.tests[0].id, "agent-written");

  const run = await call("uefn_run_test", { filter: "agent" });
  assert.equal(run.json.status, "passed", run.text);

  const events = await call("uefn_get_events", { type: "ScoreChanged" });
  assert.equal(events.json.total, 1);
  const traced = await call("uefn_trace_event", { event_id: events.json.events[0].id });
  assert.match(traced.json.tree, /capture\.completed/);

  const audit = await readFile(join(dir, ".devtools", "audit.log"), "utf8");
  assert.match(audit, /"action":"uefn_run_test"/);
  await client.close();
  await engine.close();
});

test("permissions are enforced and invalid tests are rejected", async () => {
  const ro = await connect("read_only");
  const denied = await ro.call("uefn_compile_verse");
  assert.equal(denied.isError, true);
  assert.match(denied.text, /permission 'compile'/);
  await ro.client.close();
  await ro.engine.close();

  const dev = await connect("development");
  const write = await dev.call("uefn_create_test", { file_name: "x", yaml: TEST_YAML });
  assert.match(write.text, /permission 'modify_project'/);
  await dev.client.close();
  await dev.engine.close();

  const full = await connect("full_access");
  const bad = await full.call("uefn_create_test", { file_name: "x", yaml: "name: x\nsteps:\n  - teleport: {}\n" });
  assert.equal(bad.isError, true);
  const traversal = await full.call("uefn_create_test", { file_name: "../evil", yaml: TEST_YAML });
  assert.equal(traversal.isError, true);
  await full.client.close();
  await full.engine.close();
});

test("agent records a session and generates a regression test", async () => {
  const { engine, call } = await connect("full_access");
  await call("uefn_start_session");
  const started = await call("uefn_start_recording", { name: "Agent capture", kind: "bug" });
  assert.equal(started.isError, false, started.text);
  await engine.command({ type: "start_game" });
  await engine.command({ type: "spawn_player", player: "p1", team: 1 });
  await engine.command({ type: "teleport", player: "p1", location: "A" });
  await engine.waitForEvent({ type: "score.changed" }, { timeoutMs: 10_000, fromIndex: 0 });
  const stopped = await call("uefn_stop_recording");
  assert.equal(stopped.json.summary.kind, "bug");
  const source = await call("uefn_generate_test_from_recording", { recording_id: started.json.id, format: "ts" });
  assert.match(source.text, /toHaveScore\(50\)/);
  assert.match(source.text, /BUG RECORDING/);
  const written = await call("uefn_generate_test_from_recording", { recording_id: started.json.id, write: true });
  assert.match(written.json.written, /agent-capture\.recorded\.test\.yaml$/);
  await engine.close();
});

test("generating with write=true needs modify_project", async () => {
  const { engine, call } = await connect("development");
  const r = await call("uefn_generate_test_from_recording", { recording_id: "rec_missing", write: true });
  assert.match(r.text, /modify_project/);
  await engine.close();
});
