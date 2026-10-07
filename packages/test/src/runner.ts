import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { DevToolsEngine } from "@uefn-devtools/core";
import type { RunStage, RunSummary, TestAttempt, TestResult } from "@uefn-devtools/protocol";
import { parseDuration } from "@uefn-devtools/protocol";
import { TestAbortedError, TestContext, globalState, type TestDefinition } from "./context.ts";
import { correlateFailures } from "./correlate.ts";
import { filterTests, findTestFiles, loadTests } from "./discover.ts";
import { AssertionError } from "./expect.ts";
import { createFixtures } from "./fixtures.ts";
import { slugify } from "./names.ts";

export type RunnerEvent =
  | { kind: "stage"; stage: RunStage; test?: string; iteration?: number; at: number }
  | { kind: "discovered"; tests: { id: string; name: string; file: string }[]; errors: { file: string; message: string }[] }
  | { kind: "session"; sessionId: string; reused: boolean }
  | { kind: "attempt"; test: TestRef; attempt: TestAttempt; repeat: number }
  | { kind: "test"; result: TestResult }
  | { kind: "done"; summary: RunSummary };

/** Serializable reference to a test (definitions carry functions). */
export interface TestRef {
  id: string;
  name: string;
  file: string;
}

export interface RunOptions {
  /** Defaults to a time-based id. */
  runId?: string;
  filter?: string;
  /** Run each test N times (flaky detection, spec §25). */
  repeat?: number;
  retries?: number;
  /** Base seed; iteration i uses seed + i. */
  seed?: number;
  /** Skip compilation (the caller compiled already). */
  skipBuild?: boolean;
  /** Leave the session running for the next invocation. */
  keepSession?: boolean;
  /** Restrict to these files (absolute or relative to project root). */
  files?: string[];
  onEvent?: (event: RunnerEvent) => void;
}

class StageError extends Error {
  constructor(
    readonly stage: RunStage,
    message: string,
  ) {
    super(message);
  }
}

let runCounter = 0;
/** Time-ordered and unique within a process (unbounded counter) and across processes (random). */
export function newRunId(): string {
  runCounter++;
  return `run_${Date.now().toString(36)}${runCounter.toString(36)}${randomBytes(3).toString("hex")}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Executes tests through the formal lifecycle (spec §8) and returns a deterministic verdict. */
export async function runTests(engine: DevToolsEngine, options: RunOptions = {}): Promise<RunSummary> {
  const started = Date.now();
  const runId = options.runId ?? newRunId();
  // Runner progress is mirrored onto the engine so other clients (daemon,
  // dashboard) can follow runs started by anyone.
  const emit = (event: RunnerEvent) => {
    options.onEvent?.(event);
    engine.publishActivity({ source: "runner", runId, data: event });
  };
  const artifactRoot = resolve(engine.root, engine.config.paths.results, today(), runId);
  const stage = (s: RunStage, test?: string, iteration?: number) =>
    emit({ kind: "stage", stage: s, at: Date.now(), ...(test ? { test } : {}), ...(iteration !== undefined ? { iteration } : {}) });

  const summary: RunSummary = { runId, status: "passed", startedAt: started, durationMs: 0, tests: [] };
  try {
    stage("DISCOVERING");
    const files = options.files
      ? options.files.map((f) => resolve(engine.root, f))
      : await findTestFiles(resolve(engine.root, engine.config.paths.tests));
    const { tests, errors } = await loadTests(files, { root: engine.root });
    const selected = filterTests(tests, options.filter);
    emit({
      kind: "discovered",
      tests: selected.map((t) => ({ id: t.id, name: t.name, file: relative(engine.root, t.file) })),
      errors,
    });

    stage("VALIDATING");
    if (errors.length > 0) {
      throw new StageError("VALIDATING", errors.map((e) => `${relative(engine.root, e.file)}: ${e.message}`).join("\n"));
    }
    const seen = new Map<string, string>();
    for (const t of tests) {
      const other = seen.get(t.id);
      if (other) throw new StageError("VALIDATING", `duplicate test id '${t.id}' in ${relative(engine.root, other)} and ${relative(engine.root, t.file)}`);
      seen.set(t.id, t.file);
    }
    if (selected.length === 0) {
      throw new StageError("VALIDATING", options.filter ? `no tests match '${options.filter}'` : "no tests found");
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
    const session = await engine.startSession().catch((e: Error) => {
      throw new StageError("STARTING_SESSION", e.message);
    });
    summary.sessionId = session.id;
    emit({ kind: "session", sessionId: session.id, reused: priorSession });

    stage("WAITING_FOR_RUNTIME");
    await engine.waitForRuntime().catch((e: Error) => {
      throw new StageError("WAITING_FOR_RUNTIME", `${e.message}. Is the DevTools Verse runtime installed and emitting a hello line?`);
    });

    const repeat = Math.max(1, options.repeat ?? 1);
    const retries = repeat > 1 ? 0 : (options.retries ?? engine.config.tests.retries);
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
          const run = await runAttempt(engine, def, iteration, (options.seed ?? 1) + iteration, stage);
          attempt = run.attempt;
          if (attempt.status !== "passed") {
            attempt.artifactDir = await writeFailureArtifacts(engine, artifactRoot, def, attempt, run.fromIndex, repeat > 1);
          }
          if (attempt.status === "passed") break;
        }
        attempts.push(attempt!);
        emit({ kind: "attempt", test: { id: def.id, name: def.name, file: relative(engine.root, def.file) }, attempt: attempt!, repeat });
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
  }
  stage(summary.status === "passed" ? "PASSED" : "FAILED");
  emit({ kind: "done", summary });
  return summary;
}

async function runAttempt(
  engine: DevToolsEngine,
  def: TestDefinition,
  iteration: number,
  seed: number,
  stage: (s: RunStage, test?: string, iteration?: number) => void,
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
  const ctx = new TestContext(
    engine,
    engine.events.mark(),
    parseDuration(engine.config.tests.expect_timeout),
    parseDuration(engine.config.tests.expect_settle),
  );
  const fixtures = createFixtures(ctx);

  let status: TestAttempt["status"] = "passed";
  let error: string | undefined;
  let failedStage: RunStage | undefined;

  const phase = async (s: RunStage, body: (() => Promise<void> | void) | undefined) => {
    enter(s);
    if (!body) return;
    let cancel = () => {};
    const deadline = new Promise<never>((_, reject) => {
      cancel = engine.schedule(timeoutMs - (engine.now() - startedAt), () =>
        reject(new TestAbortedError(`test timed out after ${timeoutMs}ms`)),
      );
    });
    try {
      await Promise.race([globalState.storage.run(ctx, async () => body()), deadline]);
    } finally {
      cancel();
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
  }

  enter("COLLECTING");
  const eventCounts = engine.events.countsByType(ctx.startIndex);

  enter("CLEANUP");
  if (engine.state.phase === "playing" && engine.supportsCommand("end_game")) {
    await engine.command({ type: "end_game" }).catch(() => {});
  }

  enter(status === "passed" ? "PASSED" : "FAILED");
  const attempt: TestAttempt = {
    iteration,
    status,
    durationMs: engine.now() - startedAt,
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
