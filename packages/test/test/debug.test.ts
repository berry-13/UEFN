import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevToolsEngine } from "@uefn-devtools/core";
import {
  DEBUG_ABORT_MESSAGE,
  renderFrame,
  renderStateLine,
  runTests,
  type DebugAction,
  type DebugFailureInfo,
  type DebugStepInfo,
} from "@uefn-devtools/test";
import { emptyGameState, type RuntimeEvent } from "@uefn-devtools/protocol";

async function project(config: string, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "uefn-devtools-debug-"));
  await writeFile(join(dir, "uefn-devtools.config.yaml"), config);
  await mkdir(join(dir, "Tests"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, "Tests", name), body);
  return dir;
}

const CONFIG = (captureMs: number) => `
adapter: simulated
simulated:
  time_scale: 100
  boot_ms: 100
  devices:
    - id: A
      capture_time_ms: ${captureMs}
      score: 50
tests:
  expect_timeout: 5s
`;

const yamlTest = (score: number, timeout = "30s") => `
name: Capture A
timeout: ${timeout}
setup:
  - start_game
  - spawn_player: { id: p1, team: 1 }
steps:
  - teleport: { player: p1, location: A }
  - wait_for: { event: CaptureCompleted, timeout: 5s }
assert:
  - team: { id: 1, score: ${score} }
`;

const STEPS = ["Game started", "p1 spawned on team 1", "p1 teleported to A", "capture.completed observed"];

test("debug hooks run before every step, in order, and force a single attempt", async () => {
  const dir = await project(CONFIG(2000), { "a.test.yaml": yamlTest(50) });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const seen: DebugStepInfo[] = [];
  const summary = await runTests(engine, {
    repeat: 3,
    retries: 2,
    debug: { beforeStep: (info) => void seen.push(info) },
  });
  await engine.close();
  assert.equal(summary.status, "passed", JSON.stringify(summary, null, 2));
  assert.deepEqual(seen.map((s) => s.description), STEPS);
  assert.deepEqual(seen.map((s) => s.index), [0, 1, 2, 3]);
  assert.equal(seen[0]!.test.name, "Capture A");
  assert.equal(summary.tests[0]!.attempts.length, 1);
});

test("q aborts the test with a failed status and no failure pause", async () => {
  const dir = await project(CONFIG(2000), { "a.test.yaml": yamlTest(50) });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const seen: string[] = [];
  const failures: DebugFailureInfo[] = [];
  const summary = await runTests(engine, {
    debug: {
      beforeStep: (info): DebugAction => {
        seen.push(info.description);
        return info.index === 2 ? "abort" : "step";
      },
      onFailure: (info) => void failures.push(info),
    },
  });
  await engine.close();
  const attempt = summary.tests[0]!.attempts[0]!;
  assert.equal(summary.status, "failed");
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.error, DEBUG_ABORT_MESSAGE);
  assert.deepEqual(seen, STEPS.slice(0, 3));
  assert.equal(attempt.steps.length, 2, "the aborted step never ran");
  assert.equal(failures.length, 0);
});

test("failing assertion pauses with expected and received", async () => {
  const dir = await project(CONFIG(500), { "a.test.yaml": yamlTest(75) });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const failures: DebugFailureInfo[] = [];
  const summary = await runTests(engine, {
    debug: { beforeStep: () => "continue", onFailure: (info) => void failures.push(info) },
  });
  await engine.close();
  assert.equal(summary.status, "failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.stage, "ASSERTING");
  assert.equal(failures[0]!.expected, 75);
  assert.equal(failures[0]!.received, 50);
});

test("paused time freezes the simulated clock and does not count against the timeout", async () => {
  // 1s session budget at time_scale 100 is 10 wall ms; each pause below lasts
  // 60 wall ms (6s of session time if the clock kept running).
  const dir = await project(CONFIG(300), { "a.test.yaml": yamlTest(50, "1s") });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const drift: number[] = [];
  const summary = await runTests(engine, {
    debug: {
      async beforeStep(info) {
        const before = info.engine.now();
        await new Promise((r) => setTimeout(r, 60));
        drift.push(info.engine.now() - before);
      },
    },
  });
  await engine.close();
  assert.equal(summary.status, "passed", JSON.stringify(summary.tests[0]?.attempts[0], null, 2));
  assert.deepEqual(drift, [0, 0, 0, 0]);
  assert.ok(summary.tests[0]!.attempts[0]!.durationMs < 1000);
});

test("headed frame renders the derived state", () => {
  const state = emptyGameState();
  state.phase = "playing";
  state.round = 1;
  state.teams["1"] = { id: 1, score: 50 };
  state.teams["2"] = { id: 2, score: 0 };
  state.devices["CapturePointA"] = { id: "CapturePointA", state: "Captured", owner: 1, progress: 100, enabled: true, triggerCount: 1, extra: {} };
  state.devices["CapturePointB"] = { id: "CapturePointB", state: "Capturing", progress: 45, enabled: true, triggerCount: 1, extra: {} };
  state.players["p1"] = { id: "p1", team: 1, alive: true, health: 100, score: 0, eliminations: 0, deaths: 0, areas: ["CapturePointA"], extra: {} };
  state.players["p2"] = { id: "p2", team: 2, alive: false, health: 0, score: 0, eliminations: 0, deaths: 1, areas: [], extra: {} };
  const events: RuntimeEvent[] = [
    { id: "e1", timestamp: 5200, type: "capture.completed", payload: { device: "CapturePointA", team: 1 } },
    { id: "e2", timestamp: 5200, type: "perf.span", payload: { name: "x", duration_ms: 1 } },
    { id: "e3", timestamp: 5200, type: "score.changed", payload: { team: 1, current: 50, delta: 50 } },
  ];
  const frame = renderFrame({ state, now: 6000, events, log: ["PASS"], title: "Test", width: 72 });
  assert.equal(
    frame,
    [
      "Test  t=6.00s",
      "Phase: playing   Round: 1",
      "-- Teams " + "-".repeat(63),
      "  Team 1      50",
      "  Team 2       0",
      "-- Devices " + "-".repeat(61),
      "  CapturePointA  Captured   owner 1  [####################] 100%",
      "  CapturePointB  Capturing  owner -  [#########-----------]  45%",
      "-- Players " + "-".repeat(61),
      "  p1  team 1  alive      hp 100  areas: CapturePointA",
      "  p2  team 2  eliminated hp   0  areas: -",
      "-- Recent events " + "-".repeat(55),
      "     5.20s  capture.completed (device=CapturePointA, team=1)",
      "     5.20s  score.changed (team=1, delta=50, current=50)",
      "-- Log " + "-".repeat(65),
      "  PASS",
    ].join("\n"),
  );
  assert.equal(
    renderStateLine(state, 6000),
    "[headed t=6.00s] playing | teams 1:50 2:0 | CapturePointA=Captured(owner 1, 100%) CapturePointB=Capturing(owner -, 45%) | p1(t1 hp100 @CapturePointA) p2(t2 out)",
  );
});
