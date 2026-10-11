import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByFile, mapDiagnostics, mapRunSummary, mapTestResult, planRuns } from "../dist/mapping.js";
import type { ListedTest, RunSummary, TestAttempt, TestResult } from "../src/types.ts";

function attempt(over: Partial<TestAttempt> = {}): TestAttempt {
  return { iteration: 0, status: "passed", durationMs: 100, steps: [], assertions: [], eventCounts: {}, ...over };
}

function result(over: Partial<TestResult> = {}): TestResult {
  return {
    id: "t",
    name: "T",
    file: "/p/Tests/a.test.ts",
    status: "passed",
    attempts: [attempt()],
    passed: 1,
    failed: 0,
    reliability: 1,
    correlations: [],
    ...over,
  };
}

test("a passing single attempt maps to passed with its duration and no messages", () => {
  assert.deepEqual(mapTestResult(result()), { id: "t", outcome: "passed", durationMs: 100, messages: [] });
});

test("an assertion failure becomes a diff message with the failed stage", () => {
  const failed = attempt({
    status: "failed",
    failedStage: "ASSERTING",
    assertions: [
      { description: "Team 1 score = 50", passed: true, expected: 50, received: 50, timestamp: 1 },
      { description: "Team 1 score = 50", passed: false, expected: 50, received: 0, message: "timed out", timestamp: 2 },
      { description: "owner", passed: false, expected: { team: 1 }, received: null, timestamp: 3 },
    ],
  });
  const mapped = mapTestResult(result({ status: "failed", attempts: [failed], passed: 0, failed: 1, reliability: 0 }));
  assert.equal(mapped.outcome, "failed");
  assert.deepEqual(mapped.messages, [
    { message: "Team 1 score = 50: timed out (failed in stage ASSERTING)", expected: "50", actual: "0" },
    { message: "owner (failed in stage ASSERTING)", expected: '{\n  "team": 1\n}', actual: "null" },
  ]);
});

test("an errored attempt without assertions reports its error and failed steps", () => {
  const errored = attempt({
    status: "error",
    failedStage: "RUNNING",
    error: "player1 never entered CapturePointA",
    steps: [{ description: "player1 enters CapturePointA", passed: false, durationMs: 5, timestamp: 1, error: "timeout" }],
  });
  const mapped = mapTestResult(result({ status: "error", attempts: [errored], passed: 0, failed: 1, reliability: 0 }));
  assert.equal(mapped.outcome, "errored");
  assert.deepEqual(mapped.messages.map((m) => m.message), [
    "Step failed: player1 enters CapturePointA: timeout (failed in stage RUNNING)",
    "player1 never entered CapturePointA (failed in stage RUNNING)",
  ]);
});

test("repeated runs report reliability, correlations and the first failing iteration", () => {
  const attempts = [
    attempt({ iteration: 0, seed: 1 }),
    attempt({ iteration: 1, seed: 2, status: "failed", error: "boom" }),
    attempt({ iteration: 2, seed: 3 }),
    attempt({ iteration: 3, seed: 4 }),
  ];
  const mapped = mapTestResult(
    result({
      status: "failed",
      attempts,
      passed: 3,
      failed: 1,
      reliability: 0.75,
      correlations: [{ description: "score.changed occurred 2x", failingRuns: 1, passingRuns: 0 }],
    }),
  );
  assert.equal(mapped.durationMs, 400);
  assert.equal(mapped.reliability, "Reliability 75% (3 of 4 passed, 1 failed)");
  assert.equal(mapped.messages[0]!.message, "Reliability 75% (3 of 4 passed, 1 failed)\nscore.changed occurred 2x (failing runs 1, passing runs 0)");
  assert.equal(mapped.messages[1]!.message, "Iteration 2 (seed 2): boom");

  const allPassed = mapTestResult(result({ attempts: attempts.map((a) => ({ ...a, status: "passed" as const })), passed: 4, reliability: 1 }));
  assert.equal(allPassed.outcome, "passed");
  assert.equal(allPassed.reliability, "Reliability 100% (4 of 4 passed, 0 failed)");
});

test("mapRunSummary keeps requested ids and errors the ones a run-level failure skipped", () => {
  const summary: RunSummary = {
    runId: "r",
    status: "error",
    startedAt: 0,
    durationMs: 1,
    failedStage: "BUILDING",
    error: "Verse compile failed",
    tests: [result({ id: "a" }), result({ id: "extra" })],
  };
  const mapped = mapRunSummary(summary, ["a", "b"]);
  assert.deepEqual([...mapped.keys()], ["a", "b"]);
  assert.equal(mapped.get("a")!.outcome, "passed");
  assert.deepEqual(mapped.get("b"), {
    id: "b",
    outcome: "errored",
    durationMs: 0,
    messages: [{ message: "Verse compile failed (failed in stage BUILDING)" }],
  });
});

const listed = (id: string, file: string, line?: number): ListedTest => ({ id, name: id, file, format: "typescript", ...(line ? { line } : {}) });

test("planRuns uses one unfiltered run for everything, otherwise one per id", () => {
  const all = [listed("a", "/f1"), listed("b", "/f1"), listed("c", "/f2")];
  assert.deepEqual(planRuns(["a", "b", "c"], all), [undefined]);
  assert.deepEqual(planRuns(["c", "a", "c"], all), ["c", "a"]);
  assert.deepEqual(planRuns([], all), []);
});

test("groupByFile sorts files and orders tests by line", () => {
  const groups = groupByFile([listed("z", "/b", 9), listed("y", "/a"), listed("x", "/b", 2)]);
  assert.deepEqual(
    groups.map((g) => [g.file, g.tests.map((t) => t.id)]),
    [
      ["/a", ["y"]],
      ["/b", ["x", "z"]],
    ],
  );
});

test("mapDiagnostics resolves files, converts to 0-based positions and keeps file-less ones apart", () => {
  const mapped = mapDiagnostics(
    {
      success: false,
      durationMs: 3,
      diagnostics: [
        { severity: "error", message: "Unknown identifier", file: "Verse/game.verse", line: 12, column: 5, code: "3506" },
        { severity: "warning", message: "Unused", file: "/abs/x.verse" },
        { severity: "info", message: "simulated compile" },
      ],
    },
    "/proj",
  );
  assert.deepEqual(mapped.byFile.get("/proj/Verse/game.verse"), [
    { line: 11, column: 4, severity: "error", message: "Unknown identifier", code: "3506" },
  ]);
  assert.deepEqual(mapped.byFile.get("/abs/x.verse"), [{ line: 0, column: 0, severity: "warning", message: "Unused" }]);
  assert.deepEqual(mapped.general.map((d) => d.message), ["simulated compile"]);
});

test("mapDiagnostics keeps absolute paths and resolves an older CLI's relative paths against the root", () => {
  const mapped = mapDiagnostics(
    {
      success: false,
      durationMs: 1,
      diagnostics: [
        { severity: "error", message: "a", file: "Sub/game.verse", line: 2 },
        { severity: "error", message: "b", file: "/abs/x.verse" },
      ],
    },
    "/proj",
  );
  assert.ok(mapped.byFile.has("/proj/Sub/game.verse"));
  assert.ok(mapped.byFile.has("/abs/x.verse"));
});

