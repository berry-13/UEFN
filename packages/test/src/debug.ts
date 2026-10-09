import type { DevToolsEngine } from "@uefn-devtools/core";
import type { RunStage } from "@uefn-devtools/protocol";

/**
 * Step debugging (`uefn test --debug`, docs/debugging.md). The runner calls
 * these hooks; the CLI supplies a terminal implementation, tests drive them
 * programmatically.
 */
export type DebugAction = "step" | "continue" | "abort";

export interface DebugTestInfo {
  id: string;
  name: string;
  file: string;
  iteration: number;
}

export interface DebugStepInfo {
  test: DebugTestInfo;
  /** 0-based index of the step about to run within this attempt. */
  index: number;
  description: string;
  engine: DevToolsEngine;
  /** Event-store index at which this attempt began. */
  startIndex: number;
}

export interface DebugFailureInfo {
  test: DebugTestInfo;
  stage: RunStage;
  error: string;
  /** Present when the failure is an assertion that carries expected/received. */
  expected?: unknown;
  received?: unknown;
  engine: DevToolsEngine;
  startIndex: number;
}

export interface DebugHooks {
  /**
   * Called before every step (fixture actions, YAML steps). The test is
   * paused until the promise settles. Returning `abort` fails the test.
   */
  beforeStep(info: DebugStepInfo): Promise<DebugAction | void> | DebugAction | void;
  /** Called once when an attempt fails, before cleanup. */
  onFailure?(info: DebugFailureInfo): Promise<void> | void;
}

export const DEBUG_ABORT_MESSAGE = "aborted from the debugger";
