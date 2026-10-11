import { AsyncLocalStorage } from "node:async_hooks";
import type { AssertionResult, StepResult } from "@uefn-devtools/protocol";
import type { DevToolsEngine } from "@uefn-devtools/core";
import type { SnapshotEnv } from "./snapshot.ts";
import { DEBUG_ABORT_MESSAGE, type DebugHooks, type DebugTestInfo } from "./debug.ts";
import type { YamlTest } from "./yaml.ts";

export interface TestOptions {
  /** Session-clock timeout for the whole test (`30s`, `500ms` or milliseconds). */
  timeout?: number | string;
  tags?: string[];
}

export interface TestFixtures {
  // Declared here, implemented in fixtures.ts, to avoid a circular import.
  game: import("./fixtures.ts").GameFixture;
}

export type TestBody = (fixtures: TestFixtures) => Promise<void> | void;

export interface TestDefinition {
  id: string;
  name: string;
  file: string;
  format: "typescript" | "yaml";
  /** The parsed document of a YAML test, from which its scenario device is generated. */
  yaml?: YamlTest;
  body: TestBody;
  /** YAML tests evaluate their `assert:` block in the ASSERTING stage. */
  finalAssertions?: TestBody;
  options: TestOptions;
  skip?: boolean;
  only?: boolean;
}

export class TestAbortedError extends Error {
  constructor(message = "test aborted") {
    super(message);
    this.name = "TestAbortedError";
  }
}

/** Per-attempt mutable state shared by fixtures and `expect`. */
export class TestContext {
  readonly steps: StepResult[] = [];
  readonly assertions: AssertionResult[] = [];
  aborted?: string;
  /** Unnamed `toMatchSnapshot()` calls are numbered per attempt. */
  snapshotCounter = 0;

  // Debug support, set by the runner when RunOptions.debug is given.
  debug?: DebugHooks;
  debugTest?: DebugTestInfo;
  /** Session-clock time spent paused in the debugger; excluded from the test timeout. */
  pausedMs = 0;
  /** A start_game was accepted and no end_game since: cleanup ends that match even if game.started never arrived. */
  gameStartSent = false;
  /** The running phase's timeout, disarmed while paused. */
  deadline?: { suspend(): void; resume(): void };
  private stepIndex = 0;

  constructor(
    readonly engine: DevToolsEngine,
    /** Event-store index at which this attempt began. */
    readonly startIndex: number,
    readonly expectTimeout: number,
    readonly expectSettle: number,
    readonly snapshotEnv?: SnapshotEnv,
  ) {}

  ensureActive(): void {
    if (this.aborted) throw new TestAbortedError(this.aborted);
  }

  async step<T>(description: string, fn: () => Promise<T>): Promise<T> {
    this.ensureActive();
    if (this.debug && this.debugTest) {
      const debug = this.debug;
      const info = { test: this.debugTest, index: this.stepIndex++, description, engine: this.engine, startIndex: this.startIndex };
      const action = await this.paused(() => debug.beforeStep(info));
      if (action === "abort") {
        this.aborted = DEBUG_ABORT_MESSAGE;
        throw new TestAbortedError(DEBUG_ABORT_MESSAGE);
      }
    }
    const started = this.engine.now();
    try {
      const value = await fn();
      this.steps.push({ description, passed: true, durationMs: this.engine.now() - started, timestamp: started });
      return value;
    } catch (error) {
      this.steps.push({
        description,
        passed: false,
        durationMs: this.engine.now() - started,
        timestamp: started,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Runs `fn` with the test paused: the timeout is disarmed and, when the
   * adapter clock supports it, session time is frozen (docs/debugging.md).
   */
  async paused<T>(fn: () => Promise<T> | T): Promise<T> {
    const clock = this.engine.adapter.clock;
    this.deadline?.suspend();
    const started = this.engine.now();
    clock.pause?.();
    try {
      return await fn();
    } finally {
      clock.resume?.();
      this.pausedMs += this.engine.now() - started;
      this.deadline?.resume();
    }
  }

  recordAssertion(result: Omit<AssertionResult, "timestamp">): void {
    this.assertions.push({ ...result, timestamp: this.engine.now() });
  }
}

interface GlobalTestState {
  storage: AsyncLocalStorage<TestContext>;
  registry: TestDefinition[];
  loadingFile?: string;
}

// Kept on globalThis so a test file that resolves a second copy of this
// package still registers with, and reads context from, the runner's copy.
const KEY = Symbol.for("uefn-devtools.test.state");
const g = globalThis as unknown as Record<symbol, GlobalTestState | undefined>;
export const globalState: GlobalTestState = (g[KEY] ??= {
  storage: new AsyncLocalStorage<TestContext>(),
  registry: [],
});

export function currentContext(): TestContext {
  const ctx = globalState.storage.getStore();
  if (!ctx) throw new Error("expect() and game fixtures can only be used inside a running test");
  return ctx;
}
