import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevToolsEngine } from "@uefn-devtools/core";
import { correlateFailures, loadTests, runTests } from "@uefn-devtools/test";

async function project(config: string, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "uefn-devtools-"));
  await writeFile(join(dir, "uefn-devtools.config.yaml"), config);
  await mkdir(join(dir, "Tests"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, "Tests", name), body);
  return dir;
}

const CONFIG = (fault = 0) => `
adapter: simulated
simulated:
  time_scale: 100
  boot_ms: 100
  devices:
    - id: A
      capture_time_ms: 2000
      score: 50
  faults:
    double_award_probability: ${fault}
tests:
  expect_timeout: 5s
`;

const YAML_TEST = `
name: Capture A
setup:
  - start_game
  - spawn_player: { id: p1, team: 1 }
steps:
  - teleport: { player: p1, location: A }
  - wait_for: { event: CaptureCompleted, timeout: 5s }
assert:
  - device: { id: A, state: Captured, owner: 1 }
  - team: { id: 1, score: 50 }
`;

test("yaml test passes through the full lifecycle", async () => {
  const dir = await project(CONFIG(), { "a.test.yaml": YAML_TEST });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const stages: string[] = [];
  const summary = await runTests(engine, {
    onEvent: (e) => {
      if (e.kind === "stage" && !stages.includes(e.stage)) stages.push(e.stage);
    },
  });
  await engine.close();
  assert.equal(summary.status, "passed", JSON.stringify(summary, null, 2));
  assert.equal(summary.tests[0]?.attempts[0]?.assertions.length, 3);
  assert.deepEqual(stages, [
    "DISCOVERING", "VALIDATING", "BUILDING", "STARTING_SESSION", "WAITING_FOR_RUNTIME",
    "INITIALIZING", "RUNNING", "ASSERTING", "COLLECTING", "CLEANUP", "PASSED",
  ]);
});

test("typescript test failure reports expected and received", async () => {
  const dir = await project(CONFIG(), {
    "a.test.ts": `
      import { expect, test } from "@uefn-devtools/test";
      test("wrong reward", async ({ game }) => {
        await game.start();
        await game.player("p1", { team: 1 }).enter("A");
        await expect(game.team(1)).toHaveScore(75, { timeout: "3s" });
      });
    `,
  });
  // The temp project has no node_modules; resolve the package from this workspace.
  await mkdir(join(dir, "node_modules", "@uefn-devtools"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(new URL("..", import.meta.url).pathname, join(dir, "node_modules", "@uefn-devtools", "test"));
  const engine = await DevToolsEngine.open({ cwd: dir });
  const summary = await runTests(engine, {});
  await engine.close();
  assert.equal(summary.status, "failed");
  const failed = summary.tests[0]!.attempts[0]!.assertions.find((a) => !a.passed)!;
  assert.equal(failed.expected, 75);
  assert.equal(failed.received, 50);
  assert.ok(summary.tests[0]!.attempts[0]!.artifactDir);
});

test("invalid yaml fails validation before anything runs", async () => {
  const dir = await project(CONFIG(), { "bad.test.yaml": "name: Bad\nsteps:\n  - fly: { player: p1 }\n" });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const summary = await runTests(engine, {});
  await engine.close();
  assert.equal(summary.status, "error");
  assert.equal(summary.failedStage, "VALIDATING");
});

test("repeat detects an injected double award and correlates it", async () => {
  const dir = await project(CONFIG(0.3), { "a.test.yaml": YAML_TEST });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const summary = await runTests(engine, { repeat: 20 });
  await engine.close();
  const result = summary.tests[0]!;
  assert.ok(result.failed > 0 && result.passed > 0, `expected a mix, got ${result.passed}/${result.failed}`);
  assert.match(result.correlations[0]!.description, /score\.changed occurred 2× in every failing run vs 1×/);

  // Same seeds → same failing iterations.
  const again = await DevToolsEngine.open({ cwd: dir });
  const second = await runTests(again, { repeat: 20 });
  await again.close();
  const failing = (s: typeof summary) => s.tests[0]!.attempts.filter((a) => a.status !== "passed").map((a) => a.iteration);
  assert.deepEqual(failing(second), failing(summary));
});

test("correlation needs both outcomes", () => {
  const attempt = (status: "passed" | "failed", n: number) => ({
    iteration: 0, status, durationMs: 1, steps: [], assertions: [], eventCounts: { "x.y": n },
  });
  assert.deepEqual(correlateFailures([attempt("passed", 1)]), []);
  assert.equal(correlateFailures([attempt("passed", 1), attempt("failed", 3)]).length, 1);
});

test("loading the same typescript test file twice still returns its tests", async () => {
  const body = (name: string) => `import { test } from "@uefn-devtools/test";\ntest(${JSON.stringify(name)}, async () => {});\n`;
  const dir = await project(CONFIG(), { "twice.test.ts": body("first") });
  await mkdir(join(dir, "node_modules", "@uefn-devtools"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(new URL("..", import.meta.url).pathname, join(dir, "node_modules", "@uefn-devtools", "test"));
  const file = join(dir, "Tests", "twice.test.ts");
  const names = async () => (await loadTests([file])).tests.map((t) => t.name);
  assert.deepEqual(await names(), ["first"]);
  // A long-lived host (the daemon) loads tests again for every listing and run.
  assert.deepEqual(await names(), ["first"]);
  // An edited file is picked up.
  await writeFile(file, body("second"));
  const later = new Date(Date.now() + 5000);
  await utimes(file, later, later);
  assert.deepEqual(await names(), ["second"]);
});

test("ids selects tests exactly, not by substring", async () => {
  const twice = YAML_TEST.replace("name: Capture A", "name: Capture A twice");
  const dir = await project(CONFIG(), { "a.test.yaml": YAML_TEST, "b.test.yaml": twice });
  const engine = await DevToolsEngine.open({ cwd: dir });
  try {
    const exact = await runTests(engine, { ids: ["capture-a"], keepSession: true });
    assert.equal(exact.status, "passed", JSON.stringify(exact, null, 2));
    assert.deepEqual(exact.tests.map((t) => t.id), ["capture-a"]);
    const none = await runTests(engine, { ids: ["capture"], skipBuild: true });
    assert.equal(none.status, "error");
    assert.match(none.error ?? "", /no test with id 'capture'/);
  } finally {
    await engine.close();
  }
});

test("run history records the git snapshot even when the session fails to start", async () => {
  const dir = await project(CONFIG(), { "a.test.yaml": YAML_TEST });
  const gitArgs = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
  execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: dir });
  execFileSync("git", [...gitArgs, "add", "-A"], { cwd: dir });
  execFileSync("git", [...gitArgs, "commit", "-qm", "init"], { cwd: dir });
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const engine = await DevToolsEngine.open({ cwd: dir });
  engine.adapter.startSession = async () => {
    throw new Error("no editor");
  };
  try {
    const summary = await runTests(engine, { skipBuild: true });
    assert.equal(summary.failedStage, "STARTING_SESSION");
    const row = engine.db?.listRuns().find((r) => r.runId === summary.runId);
    assert.equal(row?.gitCommit, commit);
    assert.equal(row?.gitBranch, "trunk");
  } finally {
    await engine.close();
  }
});

test("an unknown id among several requested ids fails validation instead of passing", async () => {
  const dir = await project(CONFIG(), { "a.test.yaml": YAML_TEST });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const summary = await runTests(engine, { ids: ["capture-a", "capture-b-typo"] });
  await engine.close();
  assert.equal(summary.status, "error");
  assert.equal(summary.failedStage, "VALIDATING");
  assert.match(summary.error ?? "", /no test with id 'capture-b-typo'/);
});

test("a requested test in a file that fails to load reports the load error", async () => {
  const dir = await project(CONFIG(), { "a.test.yaml": YAML_TEST, "b.test.yaml": "name: [unclosed\n" });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const summary = await runTests(engine, { ids: ["capture-b"], skipBuild: true });
  await engine.close();
  assert.equal(summary.failedStage, "VALIDATING");
  assert.match(summary.error ?? "", /b\.test\.yaml/);
  assert.doesNotMatch(summary.error ?? "", /no test with id/);
});

test("cleanup waits for the match to end before the run moves on", async () => {
  const dir = await project(CONFIG(), { "a.test.yaml": YAML_TEST });
  const engine = await DevToolsEngine.open({ cwd: dir });
  // Like UEFN: StopGame returns before the log reports the match ended.
  const real = engine.adapter.transport.bind(engine.adapter);
  engine.adapter.transport = () => {
    const inner = real();
    return {
      ...inner,
      name: inner.name,
      start: () => inner.start(),
      stop: () => inner.stop(),
      receive: () => inner.receive(),
      supportedCommands: () => inner.supportedCommands(),
      command: async (command) => {
        if (command.type !== "end_game") return inner.command(command);
        setTimeout(() => void inner.command(command), 50);
        return { ok: true };
      },
    };
  };
  try {
    const summary = await runTests(engine, { skipBuild: true, keepSession: true });
    assert.equal(summary.status, "passed", JSON.stringify(summary, null, 2));
    assert.notEqual(engine.state.phase, "playing");
  } finally {
    await engine.close();
  }
});

test("a test file that keeps failing to load is imported afresh on every retry", async () => {
  const flag = join(tmpdir(), `uefn-ready-${process.pid}-${Date.now()}`);
  const body = `import { existsSync } from "node:fs";\nimport { test } from "@uefn-devtools/test";\nif (!existsSync(${JSON.stringify(flag)})) throw new Error("not ready");\ntest("ready", async () => {});\n`;
  const dir = await project(CONFIG(), { "flaky.test.ts": body });
  await mkdir(join(dir, "node_modules", "@uefn-devtools"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(new URL("..", import.meta.url).pathname, join(dir, "node_modules", "@uefn-devtools", "test"));
  const file = join(dir, "Tests", "flaky.test.ts");
  for (let i = 0; i < 3; i++) assert.match((await loadTests([file])).errors[0]?.message ?? "", /not ready/);
  // The failure was transient; the file itself did not change.
  await writeFile(flag, "");
  assert.deepEqual((await loadTests([file])).tests.map((t) => t.name), ["ready"]);
});

test("with scenarios enabled, each YAML test tells the transport which device it expects", async () => {
  const config = `${CONFIG()}scenario:\n  enabled: true\n  locations:\n    A: [0, 0, 0]\n`;
  const dir = await project(config, { "a.test.yaml": YAML_TEST });
  const engine = await DevToolsEngine.open({ cwd: dir });
  // As on a real UEFN adapter: the simulator has no scenario devices.
  Object.defineProperty(engine, "usesScenarioDevices", { get: () => true });
  const expected: unknown[] = [];
  const real = engine.adapter.transport.bind(engine.adapter);
  engine.adapter.transport = () => Object.assign(real(), { expectScenario: (e: unknown) => void expected.push(e) });
  try {
    const summary = await runTests(engine, { skipBuild: true });
    assert.equal(summary.status, "passed", JSON.stringify(summary, null, 2));
    const { generateScenario, scenarioLocations, YamlTestSchema } = await import("@uefn-devtools/test");
    const { parseDuration } = await import("@uefn-devtools/protocol");
    const { parse } = await import("yaml");
    const plan = generateScenario(YamlTestSchema.parse(parse(YAML_TEST)), {
      id: "capture-a",
      locations: scenarioLocations(engine.config),
      startDelayMs: parseDuration(engine.config.scenario.start_delay),
    }).fingerprint;
    assert.deepEqual(expected, [{ id: "capture-a", plan }]);
  } finally {
    await engine.close();
  }
});

test("with scenarios enabled, a test whose device cannot be generated fails validation", async () => {
  // Location A has no position in scenario.locations or the simulator config.
  const dir = await project(`${CONFIG()}scenario:\n  enabled: true\n`, {
    "a.test.yaml": YAML_TEST,
    // Skipped tests are not run, so they are not validated either.
    "skipped.test.yaml": YAML_TEST.replace("name: Capture A", "name: Skipped\nskip: true").replace("location: A", "location: Nowhere"),
  });
  const engine = await DevToolsEngine.open({ cwd: dir });
  try {
    // The simulator executes player actions itself: no device, nothing to generate.
    const simulated = await runTests(engine, { skipBuild: true });
    assert.equal(simulated.status, "passed", JSON.stringify(simulated, null, 2));
    Object.defineProperty(engine, "usesScenarioDevices", { get: () => true });
    const summary = await runTests(engine, { skipBuild: true });
    assert.equal(summary.failedStage, "VALIDATING");
    assert.match(summary.error ?? "", /scenario cannot be generated for capture-a: teleport: no position for 'A'/);
    assert.doesNotMatch(summary.error ?? "", /skipped/);
  } finally {
    await engine.close();
  }
});

test("an attempt whose cleanup cannot end the match does not pass", async () => {
  const dir = await project(CONFIG(), { "a.test.yaml": YAML_TEST });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const real = engine.adapter.transport.bind(engine.adapter);
  engine.adapter.transport = () => {
    const inner = real();
    return {
      ...inner,
      name: inner.name,
      start: () => inner.start(),
      stop: () => inner.stop(),
      receive: () => inner.receive(),
      supportedCommands: () => inner.supportedCommands(),
      command: async (command) => (command.type === "end_game" ? { ok: false, error: "StopGame refused" } : inner.command(command)),
    };
  };
  try {
    const summary = await runTests(engine, { skipBuild: true });
    const attempt = summary.tests[0]!.attempts[0]!;
    assert.equal(attempt.status, "error");
    assert.equal(attempt.failedStage, "CLEANUP");
    assert.match(attempt.error ?? "", /cleanup could not end the match: StopGame refused/);
  } finally {
    await engine.close();
  }
});

test("a cleanup that leaves the match running stops retries and the rest of the run", async () => {
  const failing = YAML_TEST.replace("score: 50", "score: 999");
  const dir = await project(CONFIG(), { "a.test.yaml": failing, "b.test.yaml": YAML_TEST.replace("name: Capture A", "name: Capture B") });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const real = engine.adapter.transport.bind(engine.adapter);
  engine.adapter.transport = () => {
    const inner = real();
    return {
      ...inner,
      name: inner.name,
      start: () => inner.start(),
      stop: () => inner.stop(),
      receive: () => inner.receive(),
      supportedCommands: () => inner.supportedCommands(),
      command: async (command) => (command.type === "end_game" ? { ok: false, error: "StopGame refused" } : inner.command(command)),
    };
  };
  try {
    const summary = await runTests(engine, { skipBuild: true, retries: 2 });
    assert.equal(summary.status, "failed");
    // The failed attempt is not retried and the next test does not run.
    assert.deepEqual(summary.tests.map((t) => [t.id, t.attempts.length]), [["capture-a", 1]]);
    assert.match(summary.tests[0]!.attempts[0]!.error ?? "", /; cleanup could not end the match: StopGame refused/);
    assert.match(summary.error ?? "", /stopped after a cleanup left the match running/);
  } finally {
    await engine.close();
  }
});

test("cleanup ends a match whose start was sent even if game.started never arrived", async () => {
  const dir = await project(CONFIG().replace("expect_timeout: 5s", "expect_timeout: 1s"), { "a.test.yaml": YAML_TEST });
  const engine = await DevToolsEngine.open({ cwd: dir });
  const sent: string[] = [];
  const real = engine.adapter.transport.bind(engine.adapter);
  engine.adapter.transport = () => {
    const inner = real();
    return {
      ...inner,
      name: inner.name,
      start: () => inner.start(),
      stop: () => inner.stop(),
      // The log line for the match start is lost.
      receive: async function* () {
        for await (const e of inner.receive()) if (e.type !== "game.started") yield e;
      },
      supportedCommands: () => inner.supportedCommands(),
      command: async (command) => {
        sent.push(command.type);
        return inner.command(command);
      },
    };
  };
  try {
    const summary = await runTests(engine, { skipBuild: true });
    assert.equal(summary.tests[0]!.attempts[0]!.failedStage, "RUNNING");
    assert.ok(sent.includes("end_game"), sent.join(","));
  } finally {
    await engine.close();
  }
});

test("with scenario devices, a match that cleanup cannot end stops the run", async () => {
  const dir = await project(`${CONFIG()}scenario:\n  enabled: true\n  locations:\n    A: [0, 0, 0]\n`, { "a.test.yaml": YAML_TEST, "b.test.yaml": YAML_TEST.replace("name: Capture A", "name: Capture B") });
  const engine = await DevToolsEngine.open({ cwd: dir });
  Object.defineProperty(engine, "usesScenarioDevices", { get: () => true });
  const real = engine.adapter.transport.bind(engine.adapter);
  engine.adapter.transport = () => {
    const inner = real();
    return {
      ...inner,
      name: inner.name,
      start: () => inner.start(),
      stop: () => inner.stop(),
      receive: () => inner.receive(),
      // No end_game mapped.
      supportedCommands: () => inner.supportedCommands().filter((c) => c !== "end_game"),
      command: (command) => inner.command(command),
    };
  };
  try {
    const summary = await runTests(engine, { skipBuild: true });
    assert.deepEqual(summary.tests.map((t) => t.id), ["capture-a"]);
    assert.match(summary.tests[0]!.attempts[0]!.error ?? "", /end_game is not available/);
    assert.match(summary.error ?? "", /stopped after a cleanup left the match running/);
  } finally {
    await engine.close();
  }
});
