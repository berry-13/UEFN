import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevToolsEngine } from "@uefn-devtools/core";
import { correlateFailures, runTests } from "@uefn-devtools/test";

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

test("typescript tests reload in a long-lived process", async () => {
  const body = (score: number) => `
    import { expect, test } from "@uefn-devtools/test";
    test("reloadable", async ({ game }) => {
      await game.start();
      await game.player("p1", { team: 1 }).enter("A");
      await expect(game.team(1)).toHaveScore(${score}, { timeout: "3s" });
    });
  `;
  const dir = await project(CONFIG(), { "r.test.ts": body(50) });
  await mkdir(join(dir, "node_modules", "@uefn-devtools"), { recursive: true });
  const { symlink, utimes } = await import("node:fs/promises");
  await symlink(new URL("..", import.meta.url).pathname, join(dir, "node_modules", "@uefn-devtools", "test"));
  const engine = await DevToolsEngine.open({ cwd: dir });
  const first = await runTests(engine, { keepSession: true });
  const second = await runTests(engine, { keepSession: true, skipBuild: true });
  assert.equal(first.status, "passed");
  assert.equal(second.tests.length, 1, "cached module must still yield its tests");
  const file = join(dir, "Tests", "r.test.ts");
  await writeFile(file, body(75));
  const later = new Date(Date.now() + 5000);
  await utimes(file, later, later);
  const third = await runTests(engine, { skipBuild: true });
  await engine.close();
  assert.equal(third.status, "failed", "edited test must be re-imported");
});
