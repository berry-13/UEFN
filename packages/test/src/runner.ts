import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { captureGitInfo, type DevToolsEngine } from "@uefn-devtools/core";
import type { RunStage, RunSummary, TestAttempt, TestResult } from "@uefn-devtools/protocol";
import { parseDuration } from "@uefn-devtools/protocol";
import { TestAbortedError, TestContext, globalState, type TestDefinition } from "./context.ts";
import { correlateFailures } from "./correlate.ts";
import { DEBUG_ABORT_MESSAGE, type DebugHooks } from "./debug.ts";
import { filterTests, findTestFiles, loadTests } from "./discover.ts";
import { AssertionError } from "./expect.ts";
import { createFixtures } from "./fixtures.ts";
import { ScenarioError, generateScenario, scenarioLocations } from "./scenario.ts";
import { slugify } from "./names.ts";

export type RunnerEvent =
  | { kind: "stage"; stage: RunStage; test?: string; iteration?: number; at: number }
  | { kind: "discovered"; tests: { id: string; name: string; file: string }[]; errors: { file: string; message: string }[] }
  | { kind: "session"; sessionId: string; reused: boolean }
  | { kind: "attempt"; test: TestDefinition; attempt: TestAttempt; repeat: number }
  | { kind: "test"; result: TestResult }
  | { kind: "done"; summary: RunSummary };

export interface RunOptions {
  filter?: string;
  /** Run exactly these test ids (applied after `filter`); unlike `filter`, no substring matching. */
  ids?: string[];
  /** Run each test N times (flaky detection, spec §25). */
  repeat?: number;
  retries?: number;
  /** Base seed; iteration i uses seed + i. */
  seed?: number;
  /** Skip compilation (the caller compiled already). */
  skipBuild?: boolean;
  /** Leave the session running for the next invocation. */
  keepSession?: boolean;
  /** Overwrite stored state snapshots instead of comparing (`--update-snapshots`). */
  updateSnapshots?: boolean;
  /** Restrict to these files (absolute or relative to project root). */
  files?: string[];
  onEvent?: (event: RunnerEvent) => void;
  /** Ask the adapter for a visible game window (a hint; see StartSessionOptions). */
  headed?: boolean;
  /**
   * Step debugging: pauses before every step and on failure. Forces repeat 1
   * and retries 0; paused time does not count against the test timeout.
   */
  debug?: DebugHooks;
}

class StageError extends Error {
  constructor(
    readonly stage: RunStage,
    message: string,
  ) {
    super(message);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Executes tests through the formal lifecycle (spec §8) and returns a deterministic verdict. */
export async function runTests(engine: DevToolsEngine, options: RunOptions = {}): Promise<RunSummary> {
  const emit = options.onEvent ?? (() => {});
  const started = Date.now();
  const runId = `run_${started.toString(36)}`;
  const artifactRoot = resolve(engine.root, engine.config.paths.results, today(), runId);
  const stage = (s: RunStage, test?: string, iteration?: number) =>
    emit({ kind: "stage", stage: s, at: Date.now(), ...(test ? { test } : {}), ...(iteration !== undefined ? { iteration } : {}) });

  const summary: RunSummary = { runId, status: "passed", startedAt: started, durationMs: 0, tests: [] };
  // The run's own git snapshot: a reused session's is stale, and a session that failed to start has none.
  const git = captureGitInfo(engine.root).catch(() => undefined);
  try {
    stage("DISCOVERING");
    const files = options.files
      ? options.files.map((f) => resolve(engine.root, f))
      : await findTestFiles(resolve(engine.root, engine.config.paths.tests));
    const { tests, errors } = await loadTests(files);
    let selected = filterTests(tests, options.filter);
    let missingIds: string[] = [];
    if (options.ids) {
      const wanted = new Set(options.ids);
      selected = selected.filter((t) => wanted.has(t.id));
      const found = new Set(selected.map((t) => t.id));
      missingIds = [...wanted].filter((id) => !found.has(id));
    }
    emit({
      kind: "discovered",
      tests: selected.map((t) => ({ id: t.id, name: t.name, file: relative(engine.root, t.file) })),
      errors,
    });

    stage("VALIDATING");
    // Load errors first: a requested test in a file that failed to load is
    // missing because of that error, which is the actionable message.
    if (errors.length > 0) {
      throw new StageError("VALIDATING", errors.map((e) => `${relative(engine.root, e.file)}: ${e.message}`).join("\n"));
    }
    if (missingIds.length > 0) {
      // Every explicitly requested test must run; a typo must not pass silently.
      throw new StageError("VALIDATING", `no test with id ${missingIds.map((id) => `'${id}'`).join(", ")}`);
    }
    const seen = new Map<string, string>();
    for (const t of tests) {
      const other = seen.get(t.id);
      if (other) throw new StageError("VALIDATING", `duplicate test id '${t.id}' in ${relative(engine.root, other)} and ${relative(engine.root, t.file)}`);
      seen.set(t.id, t.file);
    }
    if (engine.config.scenario.enabled) {
      // A test whose device cannot be generated would only time out later.
      const invalid: string[] = [];
      for (const t of selected) {
        try {
          expectedScenario(engine, t);
        } catch (error) {
          invalid.push(`${t.id}: ${(error as Error).message}`);
        }
      }
      if (invalid.length > 0) throw new StageError("VALIDATING", `scenario cannot be generated for ${invalid.join("; ")}`);
    }
    if (selected.length === 0) {
      const criteria = [
        ...(options.filter ? [`'${options.filter}'`] : []),
        ...(options.ids ? [`id ${options.ids.map((id) => `'${id}'`).join(", ")}`] : []),
      ];
      throw new StageError("VALIDATING", criteria.length ? `no tests match ${criteria.join(" and ")}` : "no tests found");
    }

    if (!options.skipBuild) {
      stage("BUILDING");
      const compile = await engine.compile();
      summary.compile = {
        success: compile.success,
        durationMs: compile.durationMs,
        diagnostics: compile.diagnostics.length,
      };
      if (!compile.success) {
        await writeArtifact(artifactRoot, "compile.json", compile);
        const first = compile.diagnostics.find((d) => d.severity === "error");
        throw new StageError("BUILDING", `Verse compilation failed${first ? `: ${first.message}` : ""}`);
      }
    }

    stage("STARTING_SESSION");
    const priorSession = engine.session?.status === "connected" || engine.session?.status === "playing";
    const session = await engine.startSession(options.headed ? { headed: true } : {}).catch((e: Error) => {
      throw new StageError("STARTING_SESSION", e.message);
    });
    summary.sessionId = session.id;
    emit({ kind: "session", sessionId: session.id, reused: priorSession });

    stage("WAITING_FOR_RUNTIME");
    await engine.waitForRuntime().catch((e: Error) => {
      throw new StageError("WAITING_FOR_RUNTIME", `${e.message}. Is the DevTools Verse runtime installed and emitting a hello line?`);
    });

    const repeat = options.debug ? 1 : Math.max(1, options.repeat ?? 1);
    const retries = repeat > 1 || options.debug ? 0 : (options.retries ?? engine.config.tests.retries);
    for (const def of selected) {
      if (def.skip) {
        const result: TestResult = {
          id: def.id, name: def.name, file: relative(engine.root, def.file), status: "skipped",
          attempts: [], passed: 0, failed: 0, reliability: 1, correlations: [],
        };
        summary.tests.push(result);
        emit({ kind: "test", result });
        continue;
      }
      const attempts: TestAttempt[] = [];
      for (let iteration = 0; iteration < repeat; iteration++) {
        let attempt: TestAttempt | undefined;
        for (let retry = 0; retry <= retries; retry++) {
          const run = await runAttempt(engine, def, iteration, (options.seed ?? 1) + iteration, stage, options.updateSnapshots === true, options.debug);
          attempt = run.attempt;
          if (attempt.status !== "passed") {
            attempt.artifactDir = await writeFailureArtifacts(engine, artifactRoot, def, attempt, run.fromIndex, repeat > 1);
          }
          if (attempt.status === "passed") break;
        }
        attempts.push(attempt!);
        emit({ kind: "attempt", test: def, attempt: attempt!, repeat });
      }
      const passed = attempts.filter((a) => a.status === "passed").length;
      const result: TestResult = {
        id: def.id,
        name: def.name,
        file: relative(engine.root, def.file),
        status: passed === attempts.length ? "passed" : attempts.some((a) => a.status === "error") ? "error" : "failed",
        attempts,
        passed,
        failed: attempts.length - passed,
        reliability: passed / attempts.length,
        correlations: correlateFailures(attempts),
      };
      summary.tests.push(result);
      emit({ kind: "test", result });
    }
    summary.status = summary.tests.every((t) => t.status === "passed" || t.status === "skipped") ? "passed" : "failed";
  } catch (error) {
    summary.status = "error";
    summary.error = (error as Error).message;
    if (error instanceof StageError) summary.failedStage = error.stage;
  } finally {
    if (!options.keepSession) await engine.stopSession().catch(() => {});
    summary.durationMs = Date.now() - started;
    if (summary.tests.some((t) => t.status !== "passed" && t.status !== "skipped") || summary.status === "error") {
      summary.artifactDir = relative(engine.root, artifactRoot);
    }
    await writeArtifact(artifactRoot, "summary.json", summary).catch(() => {});
    // History must never fail a run.
    try {
      const info = await git;
      engine.db?.recordRun(summary, {
        ...(info?.commit ? { gitCommit: info.commit } : {}),
        ...(info?.branch ? { gitBranch: info.branch } : {}),
      });
    } catch {
      // ignored
    }
  }
  stage(summary.status === "passed" ? "PASSED" : "FAILED");
  emit({ kind: "done", summary });
  return summary;
}

/**
 * The scenario device a YAML test generates, so the placed one can be checked
 * against it; undefined for a test with no player actions. Throws the
 * generation error of a test whose device cannot be generated.
 */
function expectedScenario(engine: DevToolsEngine, def: TestDefinition): { id: string; plan: string } | undefined {
  if (!def.yaml) return undefined;
  try {
    const { config } = engine;
    const generated = generateScenario(def.yaml, {
      id: def.id,
      locations: scenarioLocations(config),
      startDelayMs: parseDuration(config.scenario.start_delay),
    });
    return { id: def.id, plan: generated.fingerprint };
  } catch (error) {
    if (error instanceof ScenarioError && error.kind === "no-actions") return undefined;
    throw error;
  }
}

async function runAttempt(
  engine: DevToolsEngine,
  def: TestDefinition,
  iteration: number,
  seed: number,
  stage: (s: RunStage, test?: string, iteration?: number) => void,
  updateSnapshots: boolean,
  debug?: DebugHooks,
): Promise<{ attempt: TestAttempt; fromIndex: number }> {
  const startedAt = engine.now();
  const timeoutMs = parseDuration(def.options.timeout ?? engine.config.tests.timeout);
  let currentStage: RunStage = "INITIALIZING";
  const enter = (s: RunStage) => {
    currentStage = s;
    stage(s, def.id, iteration);
  };

  enter("INITIALIZING");
  // Reset what the runtime can reset; the derived state always starts empty.
  if (engine.supportsCommand("reset")) await engine.command({ type: "reset" });
  if (engine.supportsCommand("seed")) await engine.command({ type: "seed", seed });
  engine.resetObservedState();
  if (engine.config.scenario.enabled) engine.expectScenario(expectedScenario(engine, def));
  const ctx = new TestContext(
    engine,
    engine.events.mark(),
    parseDuration(engine.config.tests.expect_timeout),
    parseDuration(engine.config.tests.expect_settle),
    { testId: def.id, file: def.file, update: updateSnapshots },
  );
  const fixtures = createFixtures(ctx);
  const debugTest = { id: def.id, name: def.name, file: relative(engine.root, def.file), iteration };
  if (debug) {
    ctx.debug = debug;
    ctx.debugTest = debugTest;
  }

  let status: TestAttempt["status"] = "passed";
  let error: string | undefined;
  let failedStage: RunStage | undefined;

  const phase = async (s: RunStage, body: (() => Promise<void> | void) | undefined) => {
    enter(s);
    if (!body) return;
    let cancel = () => {};
    let expire: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      expire = reject;
    });
    // Budget is session time minus time paused in the debugger; the debugger
    // disarms the timer while paused and re-arms it with what is left.
    const arm = () => {
      cancel = engine.schedule(timeoutMs - (engine.now() - startedAt - ctx.pausedMs), () =>
        expire(new TestAbortedError(`test timed out after ${timeoutMs}ms`)),
      );
    };
    arm();
    ctx.deadline = { suspend: () => cancel(), resume: arm };
    try {
      await Promise.race([globalState.storage.run(ctx, async () => body()), deadline]);
    } finally {
      cancel();
      delete ctx.deadline;
    }
  };

  try {
    await phase("RUNNING", () => def.body(fixtures));
    await phase("ASSERTING", def.finalAssertions ? () => def.finalAssertions!(fixtures) : undefined);
    if (ctx.assertions.length === 0 && ctx.steps.every((s) => s.passed)) {
      // A test that asserts nothing proves nothing; flag it rather than pass silently.
      throw new AssertionError("test made no assertions");
    }
  } catch (e) {
    const err = e as Error;
    status = err instanceof AssertionError ? "failed" : "error";
    if (err instanceof TestAbortedError) status = "failed";
    error = err.message;
    failedStage = currentStage;
    ctx.aborted = err.message;
    if (debug?.onFailure && err.message !== DEBUG_ABORT_MESSAGE) {
      const onFailure = debug.onFailure.bind(debug);
      await ctx.paused(() =>
        onFailure({
          test: debugTest,
          stage: currentStage,
          error: err.message,
          ...(err instanceof AssertionError ? { expected: err.expected, received: err.received } : {}),
          engine,
          startIndex: ctx.startIndex,
        }),
      );
    }
  }

  enter("COLLECTING");
  const eventCounts = engine.events.countsByType(ctx.startIndex);

  enter("CLEANUP");
  if (engine.state.phase === "playing" && engine.supportsCommand("end_game")) {
    // Wait for the match to end, as GameFixture.end() does, so a repeat or
    // retry does not start while this match (and its scenario device) winds down.
    const from = engine.events.mark();
    const ended = await engine.command({ type: "end_game" }).catch(() => undefined);
    if (ended && engine.state.phase === "playing") {
      await engine.waitForEvent({ type: "game.ended" }, { timeoutMs: ctx.expectTimeout, fromIndex: from }).catch(() => {});
    }
  }

  enter(status === "passed" ? "PASSED" : "FAILED");
  const attempt: TestAttempt = {
    iteration,
    status,
    durationMs: engine.now() - startedAt - ctx.pausedMs,
    seed,
    steps: ctx.steps,
    assertions: ctx.assertions,
    ...(error ? { error } : {}),
    ...(failedStage ? { failedStage } : {}),
    eventCounts,
  };
  return { attempt, fromIndex: ctx.startIndex };
}

async function writeArtifact(dir: string, name: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

/** Failure artifacts (spec §62): result, trace, state snapshot, compile result. */
async function writeFailureArtifacts(
  engine: DevToolsEngine,
  root: string,
  def: TestDefinition,
  attempt: TestAttempt,
  fromIndex: number,
  repeated: boolean,
): Promise<string> {
  const dir = join(root, repeated ? `${slugify(def.id)}-${attempt.iteration + 1}` : slugify(def.id));
  await writeArtifact(dir, "result.json", { test: { id: def.id, name: def.name, file: relative(engine.root, def.file) }, ...attempt });
  await writeArtifact(dir, "events.jsonl", engine.events.toJSONL(fromIndex) + "\n");
  await writeArtifact(dir, "state.json", engine.state);
  if (engine.lastCompile) await writeArtifact(dir, "compile.json", engine.lastCompile);
  if (engine.session) await writeArtifact(dir, "session.json", engine.session);
  return relative(engine.root, dir);
}
