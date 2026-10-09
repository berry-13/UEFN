import { z } from "zod";
import { Vector3 } from "./project.ts";

const Duration = z.union([z.number(), z.string()]);

export const SimulatedDevice = z.object({
  id: z.string(),
  type: z.string().default("capture_area_device"),
  location: Vector3.optional(),
  /** Game-time milliseconds a single team needs to capture the area. */
  capture_time_ms: z.number().positive().default(5000),
  score: z.number().int().default(50),
  enabled: z.boolean().default(true),
});

export const SimulatedConfig = z.object({
  /** Game milliseconds per wall-clock millisecond. */
  time_scale: z.number().positive().default(10),
  tick_ms: z.number().positive().default(100),
  teams: z.number().int().positive().default(2),
  boot_ms: z.number().nonnegative().default(1500),
  devices: z.array(SimulatedDevice).default([]),
  /**
   * Fault injection, used to exercise flaky-test detection and the bug
   * reproduction loop. Probabilities are evaluated with a seeded RNG.
   */
  faults: z
    .object({
      double_award_probability: z.number().min(0).max(1).default(0),
    })
    .default({ double_award_probability: 0 }),
  seed: z.number().int().default(1),
  /**
   * Synthetic `perf.sample` / `perf.span` events. Values derive from world
   * state and a seeded RNG (never the wall clock), so runs stay deterministic.
   */
  profiling: z
    .object({
      enabled: z.boolean().default(true),
      sample_every_ticks: z.number().int().positive().default(10),
    })
    .default({ enabled: true, sample_every_ticks: 10 }),
});
export type SimulatedConfig = z.infer<typeof SimulatedConfig>;

export const McpAdapterConfig = z.object({
  /** stdio launch of the UEFN MCP server. */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  /** Streamable HTTP endpoint, alternative to `command`. */
  url: z.string().optional(),
  /**
   * Maps DevTools operations to the tool names the UEFN MCP server exposes.
   * Kept in configuration because the official tool surface is still being
   * catalogued (docs/capabilities.md).
   */
  tools: z
    .object({
      project_info: z.string().optional(),
      compile: z.string().optional(),
      start_session: z.string().optional(),
      stop_session: z.string().optional(),
      session_state: z.string().optional(),
      /** Start / stop the in-game match (UEFN 42.30 SessionToolset has both; unverified live). */
      start_game: z.string().optional(),
      end_game: z.string().optional(),
      /** Match state (UEFN 42.30 `GetGameState`: Unconnected / CanStart / Running); makes start/end idempotent. */
      game_state: z.string().optional(),
    })
    .default({}),
  timeout_ms: z.number().positive().default(120_000),
});

/**
 * Generated scenario devices drive player actions inside a real UEFN match,
 * where no external tool can (docs/scenarios.md).
 */
export const ScenarioConfig = z.object({
  /** Route player actions (teleport, damage, ...) to the generated in-game device. */
  enabled: z.boolean().default(false),
  /** Named world positions for `teleport.location`, `enter.area` and `leave.area`. */
  locations: z.record(z.string(), Vector3).default({}),
  /** Delay after the match starts before the device runs its first step. */
  start_delay: Duration.default("3s"),
  /** How long the host waits for each step's confirmation from the device. */
  step_timeout: Duration.default("60s"),
  /** Where `uefn scenario` writes generated Verse, relative to the project root. */
  output: z.string().default("./Content/DevTools/Generated"),
});
export type ScenarioConfig = z.infer<typeof ScenarioConfig>;

export const DevToolsConfig = z.object({
  project: z.object({ name: z.string().optional() }).default({}),
  paths: z
    .object({
      verse: z.string().default("./Verse"),
      tests: z.string().default("./Tests"),
      results: z.string().default("./.devtools/results"),
    })
    .default({ verse: "./Verse", tests: "./Tests", results: "./.devtools/results" }),
  adapter: z.enum(["simulated", "mcp"]).default("simulated"),
  simulated: SimulatedConfig.default(SimulatedConfig.parse({})),
  mcp: McpAdapterConfig.default(McpAdapterConfig.parse({})),
  runtime: z
    .object({
      /** UEFN output log the Verse runtime writes DevTools lines into. */
      log_path: z.string().optional(),
      ready_timeout: Duration.default("120s"),
    })
    .default({ ready_timeout: "120s" }),
  /** SQLite persistence of sessions, events and runs (docs/persistence.md). */
  persistence: z
    .object({
      enabled: z.boolean().default(true),
      path: z.string().default("./.devtools/devtools.db"),
    })
    .default({ enabled: true, path: "./.devtools/devtools.db" }),
  instrumentation: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  scenario: ScenarioConfig.default(ScenarioConfig.parse({})),
  tests: z
    .object({
      timeout: Duration.default("30s"),
      retries: z.number().int().nonnegative().default(0),
      /** Default per-assertion polling timeout. */
      expect_timeout: Duration.default("5s"),
      /** How long a state assertion must keep holding once it matches. */
      expect_settle: Duration.default("250ms"),
    })
    .default({ timeout: "30s", retries: 0, expect_timeout: "5s", expect_settle: "250ms" }),
  mcp_server: z
    .object({
      mode: z.enum(["read_only", "development", "full_access"]).default("development"),
      permissions: z
        .object({
          read_project: z.boolean().optional(),
          compile: z.boolean().optional(),
          run_tests: z.boolean().optional(),
          start_sessions: z.boolean().optional(),
          modify_project: z.boolean().optional(),
        })
        .default({}),
    })
    .default({ mode: "development", permissions: {} }),
});
export type DevToolsConfig = z.infer<typeof DevToolsConfig>;

/** Parses `30s`, `500ms`, `2m` or a bare number of milliseconds. */
export function parseDuration(value: number | string): number {
  if (typeof value === "number") return value;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(value);
  if (!m) throw new Error(`invalid duration '${value}'`);
  const n = Number.parseFloat(m[1]!);
  switch (m[2] ?? "ms") {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    default:
      return n * 3_600_000;
  }
}
