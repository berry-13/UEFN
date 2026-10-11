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

test("the default profile covers the session the test tools started, not earlier ones", async () => {
  const { engine, client, call } = await connect("full_access");
  try {
    await call("uefn_create_test", { file_name: "agent", yaml: TEST_YAML });
    // A first session's events, then a second session started by a test tool.
    assert.equal((await call("uefn_run_test", { filter: "agent" })).json.status, "passed");
    await call("uefn_stop_session");
    assert.equal((await call("uefn_run_test", { filter: "agent" })).json.status, "passed");
    const profile = await call("uefn_profile");
    assert.ok(engine.sessionEventIndex > 0);
    assert.equal(profile.json.session.events, engine.events.size - engine.sessionEventIndex);
  } finally {
    await client.close();
    await engine.close();
  }
});

test("level tools snapshot, filter, save and diff the editor level; saving needs modify_project", async () => {
  const { dir, engine, call } = await connect("full_access");
  const noEditor = await call("uefn_level_snapshot");
  assert.equal(noEditor.isError, true);
  assert.match(noEditor.text, /needs the mcp adapter/);

  let x = 100;
  const row = (id: string, label: string, cls: string, px: number) => ({
    id,
    label,
    class: cls,
    path: `/L:P.${label}`,
    transform: { location: { x: px, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 } },
  });
  Object.assign(engine.adapter, {
    callEditorTool: async () => ({
      isError: false,
      text: "",
      json: { returnValue: JSON.stringify({ level: "/L", actors: [row("G1", "Pump", "/D/Pump.Pump_C", x), row("G2", "Tree", "/E/Tree.Tree_C", 0)], errors: [] }) },
    }),
  });

  const filtered = await call("uefn_level_snapshot", { class: "pump", save: true });
  assert.equal(filtered.isError, false, filtered.text);
  assert.equal(filtered.json.total, 2);
  assert.deepEqual(filtered.json.actors.map((a: { label: string }) => a.label), ["Pump"]);
  assert.deepEqual(filtered.json.classes, { Pump_C: 1, Tree_C: 1 });
  assert.equal(filtered.json.saved, "level.snapshot.json");
  assert.match(await readFile(join(dir, "level.snapshot.json"), "utf8"), /"label": "Pump"/);

  x = 300;
  const diff = await call("uefn_level_diff");
  assert.equal(diff.isError, false, diff.text);
  assert.deepEqual(diff.json.changed, [{ id: "G1", label: "Pump", fields: { location: [[100, 0, 0], [300, 0, 0]] } }]);

  const ro = await connect("read_only");
  Object.assign(ro.engine.adapter, { callEditorTool: (engine.adapter as unknown as { callEditorTool: unknown }).callEditorTool });
  const denied = await ro.call("uefn_level_snapshot", { save: true });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /modify_project/);
  const noBaseline = await ro.call("uefn_level_diff");
  assert.match(noBaseline.text, /does not exist; call uefn_level_snapshot with save: true first/);
  await engine.close();
  await ro.engine.close();
});
