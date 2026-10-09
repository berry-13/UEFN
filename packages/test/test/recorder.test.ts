import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevToolsEngine, Recorder, loadRecording, recordingPath, saveRecording } from "@uefn-devtools/core";
import { parseDuration } from "@uefn-devtools/protocol";
import { TestContext, createFixtures, generateYamlTest, loadStepScript, runStep, runTests } from "@uefn-devtools/test";
import { parse } from "yaml";

const CONFIG = `
adapter: simulated
simulated:
  time_scale: 100
  boot_ms: 100
  devices:
    - id: A
      capture_time_ms: 2000
      score: 50
    - id: B
      capture_time_ms: 4000
      score: 100
tests:
  expect_timeout: 5s
`;

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "uefn-rec-"));
  await writeFile(join(dir, "uefn-devtools.config.yaml"), CONFIG);
  await mkdir(join(dir, "Tests"));
  return dir;
}

async function record(dir: string, script: string) {
  await writeFile(join(dir, "script.yaml"), script);
  const steps = await loadStepScript(join(dir, "script.yaml"));
  const engine = await DevToolsEngine.open({ cwd: dir });
  try {
    await engine.startSession();
    await engine.waitForRuntime();
    await engine.command({ type: "reset" });
    engine.resetObservedState();
    const recorder = new Recorder(engine, { name: "demo" });
    recorder.start();
    const ctx = new TestContext(engine, engine.events.mark(), parseDuration("5s"), parseDuration("250ms"));
    const { game } = createFixtures(ctx);
    for (const step of steps) await runStep(game, step);
    await engine.sleep(500);
    return recorder.stop();
  } finally {
    await engine.close();
  }
}

async function replay(dir: string, yaml: string) {
  await writeFile(join(dir, "Tests", "generated.test.yaml"), yaml);
  const engine = await DevToolsEngine.open({ cwd: dir });
  try {
    return await runTests(engine, {});
  } finally {
    await engine.close();
  }
}

test("a recorded capture generates a yaml test that passes", async () => {
  const dir = await project();
  const recording = await record(
    dir,
    `
- start_game
- spawn_player: { id: p1, team: 1 }
- enter: { player: p1, area: A }
- wait: 3s
`,
  );
  assert.ok(recording.events.some((e) => e.type === "capture.completed"));
  assert.equal(recording.adapter, "simulated");
  assert.ok(recording.session?.id);

  const { test: generated, yaml } = generateYamlTest(recording, { name: "Demo capture" });
  assert.deepEqual(generated.setup, ["start_game", { spawn_player: { id: "p1", team: 1 } }]);
  // A recorded pause may precede it: at time_scale 100 a few wall ms of load is half a second of game time.
  const firstAction = generated.steps.find((s) => !(typeof s === "object" && "wait" in s));
  assert.equal(typeof firstAction === "object" && "enter" in firstAction, true);
  assert.ok(generated.steps.some((s) => typeof s === "object" && "wait_for" in s));
  assert.deepEqual(generated.assert, [
    { device: { id: "A", state: "Captured", owner: 1 } },
    { device: { id: "B", state: "Neutral" } },
    { team: { id: 1, score: 50 } },
    { event: { type: "capture.completed", times: 1 } },
    { event: { type: "score.changed", times: 1 } },
  ]);
  assert.ok(parse(yaml), "output is valid yaml");

  const summary = await replay(dir, yaml);
  assert.equal(summary.status, "passed", JSON.stringify(summary, null, 2));
  assert.equal(summary.tests[0]!.id, "demo-capture");
});

test("waits, eliminations and device toggles round-trip", async () => {
  const dir = await project();
  const recording = await record(
    dir,
    `
- start_game
- spawn_player: { id: p1, team: 1 }
- spawn_player: { id: p2, team: 2 }
- disable_device: { id: B }
- enter: { player: p1, area: B }
- wait: 1s
- eliminate: { player: p1, by: p2 }
- enter: { player: p2, area: A }
- wait: 3s
- enable_device: { id: B }
`,
  );
  const { test: generated, yaml } = generateYamlTest(recording, { name: "Mixed", players: true });
  const kinds = generated.steps.map((s) => (typeof s === "string" ? s : Object.keys(s)[0]));
  assert.ok(kinds.includes("disable_device") && kinds.includes("eliminate") && kinds.includes("enable_device"), kinds.join());
  assert.ok(kinds.includes("wait"), "gaps become waits");
  assert.equal(kinds.filter((k) => k === "leave").length, 0, "exits caused by elimination or teleport are implied");

  const summary = await replay(dir, yaml);
  assert.equal(summary.status, "passed", JSON.stringify(summary, null, 2));
});

test("recordings save to disk and regenerate the same test", async () => {
  const dir = await project();
  const recording = await record(dir, "- start_game\n- spawn_player: { id: p1, team: 1 }\n- enter: { player: p1, area: A }\n- wait: 3s\n");
  const file = recordingPath(dir, "demo");
  assert.match(file, /\.devtools\/recordings\/demo\.uefnrec\.json$/);
  await saveRecording(recording, file);
  const loaded = await loadRecording(file);
  assert.equal(generateYamlTest(loaded).yaml, generateYamlTest(recording).yaml);
});

test("a disable during a recording of an already running game becomes a step", async () => {
  const dir = await project();
  await writeFile(join(dir, "script.yaml"), "- start_game\n");
  const steps = await loadStepScript(join(dir, "script.yaml"));
  const engine = await DevToolsEngine.open({ cwd: dir });
  let recording;
  try {
    await engine.startSession();
    await engine.waitForRuntime();
    await engine.command({ type: "reset" });
    engine.resetObservedState();
    const ctx0 = new TestContext(engine, engine.events.mark(), parseDuration("5s"), parseDuration("250ms"));
    for (const step of steps) await runStep(createFixtures(ctx0).game, step);
    await engine.sleep(500);
    const recorder = new Recorder(engine, { name: "running" });
    recorder.start();
    const ctx = new TestContext(engine, engine.events.mark(), parseDuration("5s"), parseDuration("250ms"));
    const { game } = createFixtures(ctx);
    await runStep(game, { disable_device: { id: "B" } });
    await engine.sleep(500);
    recording = recorder.stop();
  } finally {
    await engine.close();
  }
  const { test: generated, yaml } = generateYamlTest(recording, { name: "Running game" });
  const all = [...generated.setup, ...generated.steps];
  assert.ok(all.some((s) => typeof s === "object" && "disable_device" in s), JSON.stringify(all));
  assert.ok(generated.assert.some((a) => "device" in a && a.device.id === "B" && a.device.enabled === false));
});

test("a newline in the recording name cannot inject yaml", async () => {
  const dir = await project();
  const recording = await record(dir, "- start_game\n");
  recording.name = "evil\ninjected: true\r# x";
  const { test: generated, yaml } = generateYamlTest(recording);
  const doc = parse(yaml) as Record<string, unknown>;
  assert.equal(doc["injected"], undefined);
  assert.equal(doc["name"], generated.name);
  assert.equal(generated.name, "evil\ninjected: true\r# x");
  assert.ok(yaml.split("\n").filter((l) => l.startsWith("#")).length === 2);
});
