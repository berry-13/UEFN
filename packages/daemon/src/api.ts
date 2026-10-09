import type { CausalNode, DevToolsEngine } from "@uefn-devtools/core";
import type { GameState, RunSummary, RuntimeEvent, Session } from "@uefn-devtools/protocol";

/** Wire shapes of the daemon HTTP API (see docs/daemon.md). Type-only, so clients stay light. */

export const DAEMON_VERSION = "0.1.0";

/** Contents of `<root>/.devtools/daemon.json`. */
export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  root: string;
  /** Epoch milliseconds. */
  startedAt: number;
  version: string;
  /** True when the daemon serves the desktop UI under `/` (started with a `staticDir`). */
  ui?: boolean;
}

export interface SessionSnapshot {
  session: Session | null;
  runtimeReady: boolean;
  phase: GameState["phase"];
}

export interface StatusResponse extends SessionSnapshot {
  project: string;
  root: string;
  adapter: string;
  /** Number of events in the session log. */
  events: number;
  /** True while a compile, session change or test run holds the lock. */
  busy: boolean;
  daemon: { pid: number; port: number; startedAt: number; version: string; streams: number; ui: boolean };
}

export interface EventsResponse {
  events: (RuntimeEvent & { index: number })[];
  /** Pass as `fromIndex` to continue after the last scanned event. */
  nextIndex: number;
  /** Total events in the log. */
  size: number;
}

export interface TraceResponse {
  tree: CausalNode;
  /** Root-to-event ids. */
  ancestry: string[];
  /** The tree rendered as text, as `uefn trace` prints it. */
  text: string;
}

export interface StateAtResponse {
  index: number;
  timestamp: number;
  state: GameState;
}

export interface TestsResponse {
  tests: { id: string; name: string; file: string; format: "typescript" | "yaml" }[];
  errors: { file: string; message: string }[];
}

export interface RunTestsRequest {
  filter?: string;
  repeat?: number;
  seed?: number;
  /** Compile Verse first (default true). */
  compile?: boolean;
}

export type RunTestsResponse = RunSummary;

/** JSON-safe form of the runner's progress events (test bodies are reduced to id/name/file). */
export type RunnerStreamEvent = { kind: string; [key: string]: unknown };

/** Messages on `GET /api/stream`, keyed by SSE event name. */
export interface StreamMessages {
  runtime: RuntimeEvent & { index: number };
  runner: RunnerStreamEvent;
  session: SessionSnapshot;
}

export type CapabilitiesResponse = Awaited<ReturnType<DevToolsEngine["capabilities"]>>;

export interface ApiError {
  error: string;
}
