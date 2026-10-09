import type { DevToolsEngine } from "@uefn-devtools/core";
import type { ReporterOptions, RunOptions } from "@uefn-devtools/test";
import { createTerminalDebugger } from "./debugger.ts";
import { HeadedView } from "./headed-view.ts";
import { UsageError, type Values } from "./shared.ts";

/** Validates `--headed` / `--debug` before anything starts. */
export function assertInteractive(values: Values): void {
  if (values.json && (values.headed || values.debug)) {
    throw new UsageError("--headed and --debug cannot be combined with --json");
  }
  if (values.debug && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new UsageError("--debug needs an interactive terminal (stdin and stdout must be a TTY)");
  }
}

export interface Interactive {
  runOptions: Pick<RunOptions, "headed" | "debug">;
  reporter: Pick<ReporterOptions, "write">;
  stop(): void;
}

/**
 * Wires `--headed` (live state view) and `--debug` (step debugger) into a
 * test run. With `--debug` the pause screen already shows the state, so the
 * live view is not started.
 */
export function startInteractive(values: Values, engine: DevToolsEngine): Interactive {
  const headed = values.headed === true;
  if (values.debug) {
    const debug = createTerminalDebugger();
    return { runOptions: { debug, ...(headed ? { headed } : {}) }, reporter: {}, stop: () => debug.close() };
  }
  if (!headed) return { runOptions: {}, reporter: {}, stop: () => {} };
  const view = new HeadedView(engine);
  view.start();
  return { runOptions: { headed }, reporter: { write: (text) => view.log(text) }, stop: () => view.stop() };
}
