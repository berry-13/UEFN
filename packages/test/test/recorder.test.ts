import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevToolsEngine, listRecordings, loadRecording, summarizeRecording } from "@uefn-devtools/core";
import { YamlTestSchema, generateTest, runTests, toTypeScript, toYaml } from "@uefn-devtools/test";
import { parse } from "yaml";

const config = (fault: number) => `
simulated:
  time_scale: 100
  boot_ms: 100
  seed: 3
  devices:
    - id: A
      capture_time_ms: 2000
      score: 50
    - id: B
      capture_time_ms: 1000
      score: 100
  faults:
    double_award_probability: ${fault}
tests:
  expect_timeout: 10s
`;

async function project(fault = 0) {
  const dir = await mkdtemp(join(tmpdir(), "uefn-rec-"));
  await writeFile(join(dir, "uefn-devtools.config.yaml"), config(fault));
  await mkdir(join(dir, "Tests"));
  await mkdir(join(dir, "node_modules", "@uefn-devtools"), { recursive: true });
  await symlink(new URL("..", import.meta.url).pathname, join(dir, "node_modules", "@uefn-devtools", "test"));
  const engine = await DevToolsEngine.open({ cwd: dir });
  await engine.startSession();
  await engine.waitForRuntime();
  return { dir, engine };
}

/** Plays a short match by hand (as a developer would in a live session). */
async function play(engine: DevToolsEngine) {
  await engine.command({ type: "start_game" });
  await engine.command({ type: "spawn_player", player: "alice", team: 1 });
  await engine.command({ type: "spawn_player", player: "bob", team: 2 });
  await engine.command({ type: "teleport", player: "alice", location: "A" });
  await engine.waitForEvent({ type: "capture.completed", payload: { device: "A" } }, { timeoutMs: 10_000 });
  await engine.command({ type: "teleport", player: "bob", location: "B" });
  await engine.waitForEvent({ type: "capture.completed", payload: { device: "B" } }, { timeoutMs: 10_000 });
  await engine.command({ type: "eliminate_player", player: "bob", by: "alice" });
  await engine.sleep(300);
}

test("a recorded session becomes a passing test in both formats", async (t) => {
  const { dir, engine } = await project();
  t.after(() => engine.close());
  engine.startRecording({ name: "Two captures and an elimination" });
  await play(engine);
  const { recording } = await engine.stopRecording();
  assert.equal((await listRecordings(dir))[0]?.id, recording.id);
  assert.deepEqual((await loadRecording(dir, recording.id)).events.length, recording.events.length);

  const generated = generateTest(recording);
  // Actions only: no capture/score events turned into steps.
  const kinds = [...generated.setup, ...generated.steps].map((s) => (typeof s === "string" ? s : Object.keys(s)[0]));
  assert.deepEqual(kinds, ["start_game", "spawn_player", "spawn_player", "enter", "wait_for", "enter", "wait_for", "eliminate"]);
  assert.deepEqual(generated.assert, [
    { device: { id: "A", state: "Captured", owner: 1 } },
    { device: { id: "B", state: "Captured", owner: 2 } },
    { team: { id: 1, score: 50 } },
    { team: { id: 2, score: 100 } },
    { player: { id: "bob", alive: false } },
  ]);

  const yaml = toYaml(generated, { recordingId: recording.id });
  assert.ok(YamlTestSchema.safeParse(parse(yaml)).success, yaml);
  await writeFile(join(dir, "Tests", "recorded.test.yaml"), yaml);
  await writeFile(join(dir, "Tests", "recorded.test.ts"), toTypeScript({ ...generated, name: `${generated.name} (ts)` }, { recordingId: recording.id }));

  const summary = await runTests(engine, { skipBuild: true });
  await engine.close();
  assert.equal(summary.status, "passed", JSON.stringify(summary.tests.map((t) => [t.name, t.attempts[0]?.error]), null, 2));
  assert.equal(summary.tests.length, 2);
});

test("bug recordings report the duplicate award and flag observed assertions", async (t) => {
  const { engine } = await project(1);
  t.after(() => engine.close());
  engine.startRecording({ name: "Double score", kind: "bug" });
  await engine.command({ type: "start_game" });
  await engine.command({ type: "teleport", player: "p1", location: "A" }).catch(() => {});
  await engine.command({ type: "spawn_player", player: "p1", team: 1 });
  await engine.command({ type: "teleport", player: "p1", location: "A" });
  await engine.waitForEvent({ type: "capture.completed" }, { timeoutMs: 10_000 });
  await engine.sleep(200);
  const { recording } = await engine.stopRecording();
  await engine.close();

  const summary = summarizeRecording(recording);
  assert.deepEqual(summary.devices, ["A", "B"]);
  const dup = summary.anomalies.find((a) => a.rule === "duplicate-effect");
  assert.ok(dup, JSON.stringify(summary.anomalies));
  assert.match(dup.message, /score\.changed fired 2× from the same capture\.completed/);
  assert.ok(dup.traceIds.length > 0);

  const generated = generateTest(recording);
  assert.deepEqual(generated.assert.find((a) => "team" in a), { team: { id: 1, score: 100 } });
  assert.match(generated.notes[0]!, /OBSERVED/);
});

test("recording requires a session and only one at a time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-rec-"));
  await writeFile(join(dir, "uefn-devtools.config.yaml"), config(0));
  const engine = await DevToolsEngine.open({ cwd: dir });
  assert.throws(() => engine.startRecording(), /start a session/);
  await engine.startSession();
  engine.startRecording();
  assert.throws(() => engine.startRecording(), /already in progress/);
  await engine.stopRecording();
  await assert.rejects(engine.stopRecording(), /no recording/);
  await engine.close();
});

test("damage that kills implies the elimination; damage that doesn't, doesn't", async (t) => {
  const { engine } = await project();
  t.after(() => engine.close());
  engine.startRecording({ name: "Damage" });
  await engine.command({ type: "start_game" });
  await engine.command({ type: "spawn_player", player: "a", team: 1 });
  await engine.command({ type: "spawn_player", player: "b", team: 2 });
  await engine.command({ type: "damage_player", player: "a", amount: 30 });
  await engine.command({ type: "eliminate_player", player: "a" });
  await engine.command({ type: "damage_player", player: "b", amount: 100 });
  await engine.sleep(100);
  const { recording } = await engine.stopRecording();
  const steps = generateTest(recording).steps;
  assert.deepEqual(steps, [
    { damage: { player: "a", amount: 30 } },
    { eliminate: { player: "a" } },
    { damage: { player: "b", amount: 100 } },
  ]);
});

test("runtime text in notes cannot escape comments; bindings avoid reserved words; ids stay unique", async (t) => {
  const { engine, dir } = await project(1);
  t.after(() => engine.close());
  engine.startRecording({ name: "Injected", kind: "bug" });
  await engine.command({ type: "start_game" });
  await engine.command({ type: "spawn_player", player: "class", team: 1 });
  await engine.command({ type: "teleport", player: "class", location: "A" });
  await engine.waitForEvent({ type: "capture.completed" }, { timeoutMs: 10_000 });
  await engine.sleep(100);
  const { recording } = await engine.stopRecording();
  // A runtime log line carrying a payload, as the log transport would deliver it.
  recording.events.push({
    id: "log_x", timestamp: recording.events.at(-1)!.timestamp + 1, type: "log",
    source: { type: "system", id: "LogVerse" },
    payload: { level: "error", message: "boom\nglobalThis.pwned = true;\u2028globalThis.pwned2 = true;" },
  });
  const generated = generateTest(recording);
  const ts = toTypeScript(generated, { recordingId: recording.id });
  for (const line of ts.split(/\r?\n|\u2028|\u2029/)) {
    if (line.includes("pwned")) assert.match(line, /^\/\/ /, `escaped comment: ${line}`);
  }
  assert.match(ts, /const class_ = game\.player\("class"/);
  const yaml = toYaml(generated, { recordingId: recording.id });
  for (const line of yaml.split(/\r?\n/)) if (line.includes("pwned")) assert.match(line, /^# /);

  const { writeGeneratedTest } = await import("@uefn-devtools/test");
  const testsDir = join(dir, "Tests");
  const a = await writeGeneratedTest(testsDir, generated, "yaml");
  const b = await writeGeneratedTest(testsDir, generated, "ts");
  const c = await writeGeneratedTest(testsDir, generated, "yaml");
  assert.match(a, /injected\.recorded\.test\.yaml$/);
  assert.match(b, /injected-2\.recorded\.test\.ts$/);
  assert.match(c, /injected-3\.recorded\.test\.yaml$/);
  const { loadTests, findTestFiles } = await import("@uefn-devtools/test");
  const loaded = await loadTests(await findTestFiles(testsDir), { root: dir });
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.tests.map((x) => x.id).sort(), ["injected", "injected-2", "injected-3"]);
});

test("a mid-game recording reconstructs players who were already playing", async (t) => {
  const { dir, engine } = await project();
  t.after(() => engine.close());
  await engine.command({ type: "start_game" });
  await engine.command({ type: "spawn_player", player: "bob", team: 2 });
  await engine.command({ type: "spawn_player", player: "alice", team: 1 });
  await engine.command({ type: "teleport", player: "alice", location: "A" });
  await engine.waitForEvent({ type: "player.entered_area", payload: { player: "alice" } }, { timeoutMs: 5000, fromIndex: 0 });
  engine.startRecording({ name: "Mid game" });
  await engine.command({ type: "teleport", player: "bob", location: "B" });
  await engine.waitForEvent({ type: "capture.completed", payload: { device: "B" } }, { timeoutMs: 10_000 });
  await engine.waitForEvent({ type: "capture.completed", payload: { device: "A" } }, { timeoutMs: 10_000, fromIndex: 0 });
  await engine.sleep(100);
  const { recording } = await engine.stopRecording();
  const generated = generateTest(recording);
  assert.deepEqual(generated.setup, [
    "start_game",
    { spawn_player: { id: "bob", team: 2 } },
    { spawn_player: { id: "alice", team: 1 } },
  ]);
  assert.deepEqual(generated.steps[0], { enter: { player: "alice", area: "A" } });
  assert.ok(generated.notes.some((n) => /inside areas/.test(n)));
  await writeFile(join(dir, "Tests", "mid.test.yaml"), toYaml(generated));
  const summary = await runTests(engine, { skipBuild: true, keepSession: true });
  assert.equal(summary.status, "passed", JSON.stringify(summary.tests.map((x) => x.attempts[0]?.error)));
});

test("stop fixes the window at the call, survives a failed save, and ends with the session", async (t) => {
  const { dir, engine } = await project();
  t.after(() => engine.close());
  const { rm, writeFile: write, mkdir: mk } = await import("node:fs/promises");
  engine.startRecording({ name: "Window" });
  await engine.command({ type: "start_game" });
  await engine.sleep(50);
  // Make the save fail: a file where the recordings directory should be.
  await mk(join(dir, ".devtools"), { recursive: true });
  await write(join(dir, ".devtools", "recordings"), "not a directory");
  const stopping = engine.stopRecording();
  await engine.command({ type: "spawn_player", player: "late", team: 1 });
  await assert.rejects(stopping);
  assert.ok(engine.activeRecording, "a failed save must not lose the recording");
  await rm(join(dir, ".devtools", "recordings"));
  const { recording } = await engine.stopRecording();
  assert.equal(engine.activeRecording, undefined);
  assert.ok(!recording.events.some((e) => e.type === "player.spawned"), "events after Stop were included");

  engine.startRecording({ name: "Ends with session" });
  await engine.stopSession();
  assert.equal(engine.activeRecording, undefined);
  assert.ok((await listRecordings(dir)).some((r) => r.name === "Ends with session"));
});

test("concurrent YAML and TS generation get distinct ids", async (t) => {
  const { dir, engine } = await project();
  t.after(() => engine.close());
  engine.startRecording({ name: "Twice" });
  await engine.command({ type: "start_game" });
  await engine.command({ type: "spawn_player", player: "p", team: 1 });
  await engine.command({ type: "teleport", player: "p", location: "A" });
  await engine.waitForEvent({ type: "capture.completed" }, { timeoutMs: 10_000 });
  await engine.sleep(50);
  const { recording } = await engine.stopRecording();
  const { writeGeneratedTest, loadTests, findTestFiles } = await import("@uefn-devtools/test");
  const g = generateTest(recording);
  await Promise.all([writeGeneratedTest(join(dir, "Tests"), g, "yaml"), writeGeneratedTest(join(dir, "Tests"), g, "ts")]);
  const loaded = await loadTests(await findTestFiles(join(dir, "Tests")), { root: dir });
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.tests.map((x) => x.id).sort(), ["twice", "twice-2"]);
});
