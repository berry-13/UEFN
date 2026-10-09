/**
 * Wire shapes the extension reads from the `uefn` CLI (`--json`) and the
 * daemon HTTP API. Duplicated from @uefn-devtools/protocol and
 * @uefn-devtools/daemon (which are ESM) so this CommonJS bundle has no
 * runtime or type dependency on workspace packages. Keep in sync with
 * packages/protocol/src/{testing,project,events,state}.ts and
 * packages/daemon/src/api.ts.
 */

export type TestFormat = "typescript" | "yaml";

/** One entry of `uefn list --json`. */
export interface ListedTest {
  id: string;
  name: string;
  file: string;
  format: TestFormat;
  /** 1-based line of the test definition, when the CLI found it. */
  line?: number;
  skip?: boolean;
}

export interface ListResult {
  root: string;
  testsDir: string;
  tests: ListedTest[];
  errors: { file: string; message: string }[];
}

export type RunStage =
  | "DISCOVERING"
  | "VALIDATING"
  | "BUILDING"
  | "STARTING_SESSION"
  | "WAITING_FOR_RUNTIME"
  | "INITIALIZING"
  | "RUNNING"
  | "ASSERTING"
  | "COLLECTING"
  | "CLEANUP"
  | "PASSED"
  | "FAILED";

export interface AssertionResult {
  description: string;
  passed: boolean;
  expected?: unknown;
  received?: unknown;
  message?: string;
  timestamp: number;
}

export interface StepResult {
  description: string;
  passed: boolean;
  durationMs: number;
  timestamp: number;
  error?: string;
}

export type TestStatus = "passed" | "failed" | "error" | "skipped";

export interface TestAttempt {
  iteration: number;
  status: TestStatus;
  durationMs: number;
  seed?: number;
  steps: StepResult[];
  assertions: AssertionResult[];
  error?: string;
  failedStage?: RunStage;
  eventCounts: Record<string, number>;
  artifactDir?: string;
}

export interface Correlation {
  description: string;
  failingRuns: number;
  passingRuns: number;
}

export interface TestResult {
  id: string;
  name: string;
  file: string;
  status: TestStatus;
  attempts: TestAttempt[];
  passed: number;
  failed: number;
  /** passed / attempts, 0..1. */
  reliability: number;
  correlations: Correlation[];
}

export interface RunSummary {
  runId: string;
  status: "passed" | "failed" | "error";
  startedAt: number;
  durationMs: number;
  failedStage?: RunStage;
  error?: string;
  tests: TestResult[];
  compile?: { success: boolean; durationMs: number; diagnostics: number };
  sessionId?: string;
  artifactDir?: string;
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
}

export interface CompileResult {
  success: boolean;
  durationMs: number;
  diagnostics: Diagnostic[];
  raw?: string;
}

export interface EntityReference {
  type: string;
  id: string;
}

export interface RuntimeEvent {
  id: string;
  timestamp: number;
  type: string;
  source?: EntityReference;
  target?: EntityReference;
  traceId?: string;
  parentEventId?: string;
  payload: Record<string, unknown>;
}

export interface CausalNode {
  event: RuntimeEvent;
  children: CausalNode[];
}

export interface TraceResponse {
  tree: CausalNode;
  ancestry: string[];
  text: string;
}

export interface PlayerState {
  id: string;
  team?: number;
  alive: boolean;
  health?: number;
  shield?: number;
  score: number;
  eliminations: number;
  deaths: number;
  areas: string[];
}

export interface DeviceState {
  id: string;
  type?: string;
  enabled: boolean;
  state?: string;
  owner?: number;
  progress?: number;
  triggerCount: number;
}

export interface TeamState {
  id: number;
  score: number;
}

export interface GameState {
  phase: "idle" | "playing" | "ended";
  round: number;
  winner?: number;
  players: Record<string, PlayerState>;
  devices: Record<string, DeviceState>;
  teams: Record<string, TeamState>;
  probes: Record<string, unknown>;
}

/** Contents of `<root>/.devtools/daemon.json`. */
export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  root: string;
  startedAt: number;
  version: string;
}

export interface SessionSnapshot {
  session: { id: string; status: string } | null;
  runtimeReady: boolean;
  phase: GameState["phase"];
}

export interface StatusResponse extends SessionSnapshot {
  project: string;
  root: string;
  adapter: string;
  events: number;
  busy: boolean;
}
