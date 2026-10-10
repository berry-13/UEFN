import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuditLog, DevToolsEngine, formatCausalTree } from "@uefn-devtools/core";
import { buildProfile } from "@uefn-devtools/core";
import type { RunSummary } from "@uefn-devtools/protocol";
import {
  YamlTestSchema,
  filterTests,
  findTestFiles,
  loadTests,
  normalizeEventType,
  runTests,
} from "@uefn-devtools/test";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { resolvePermissions, type Permission, type PermissionSet } from "./permissions.ts";

export interface DevToolsMcpOptions {
  engine: DevToolsEngine;
  mode?: "read_only" | "development" | "full_access";
  actor?: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Serialises operations that touch the session, so concurrent agent calls cannot interleave runs. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

/** Compact, agent-oriented view of a run: verdicts, failures and where the evidence is. */
export function summarizeRun(summary: RunSummary): Record<string, unknown> {
  return {
    status: summary.status,
    ...(summary.failedStage ? { failedStage: summary.failedStage, error: summary.error } : {}),
    compile: summary.compile,
    durationMs: summary.durationMs,
    tests: summary.tests.map((t) => ({
      id: t.id,
      status: t.status,
      runs: t.attempts.length,
      passed: t.passed,
      failed: t.failed,
      reliability: t.reliability,
      ...(t.correlations.length ? { correlations: t.correlations.map((c) => c.description) } : {}),
      failures: t.attempts
        .filter((a) => a.status !== "passed")
        .slice(0, 3)
        .map((a) => ({
          iteration: a.iteration + 1,
          seed: a.seed,
          stage: a.failedStage,
          error: a.error,
          failedAssertions: a.assertions.filter((x) => !x.passed).map((x) => ({
            assertion: x.description,
            expected: x.expected,
            received: x.received,
          })),
          artifacts: a.artifactDir,
        })),
    })),
  };
}

/**
 * MCP surface over the DevTools engine (spec §41–42). Tool names use the
 * `uefn_` prefix instead of `uefn.` because several MCP clients reject
 * dots in tool names. There is deliberately no shell or arbitrary file tool.
 */
export function createDevToolsMcpServer(options: DevToolsMcpOptions): McpServer {
  const { engine } = options;
  const permissions: PermissionSet = resolvePermissions(engine.config.mcp_server, options.mode);
  const audit = new AuditLog(join(engine.root, ".devtools", "audit.log"));
  const actor = options.actor ?? "mcp-client";
  const lock = new Mutex();
  const server = new McpServer({ name: "uefn-devtools", version: "0.1.0" });

  const guarded = <A>(name: string, scope: Permission, handler: (args: A) => Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      if (!permissions[scope]) {
        await audit.record({ actor, action: name, outcome: "denied", detail: { scope } }).catch(() => {});
        return fail(`permission '${scope}' is not granted to this MCP server (mcp_server.mode / mcp_server.permissions)`);
      }
      try {
        const result = await handler(args);
        await audit.record({ actor, action: name, outcome: result.isError ? "error" : "ok", detail: args as Record<string, unknown> }).catch(() => {});
        return result;
      } catch (error) {
        await audit.record({ actor, action: name, outcome: "error", detail: { message: (error as Error).message } }).catch(() => {});
        return fail((error as Error).message);
      }
    };

  // ── project ─────────────────────────────────────────────────────────────
  server.registerTool(
    "uefn_get_project",
    { description: "Project name, root, Verse files and test files discovered by DevTools." },
    guarded("uefn_get_project", "read_project", async () => ok(await engine.project())),
  );

  server.registerTool(
    "uefn_get_capabilities",
    {
      description:
        "What the active UEFN adapter can do: each feature classified DIRECT / INSTRUMENTED / DERIVED / BLOCKED / UNKNOWN. Check this before assuming a runtime command is available.",
    },
    guarded("uefn_get_capabilities", "read_project", async () => ok(await engine.capabilities())),
  );

  // ── verse ───────────────────────────────────────────────────────────────
  server.registerTool(
    "uefn_compile_verse",
    { description: "Compile the project's Verse. Never claim Verse code is valid until this reports success." },
    guarded("uefn_compile_verse", "compile", () => lock.run(async () => ok(await engine.compile()))),
  );

  server.registerTool(
    "uefn_get_compile_errors",
    { description: "Diagnostics from the most recent compile in this server process." },
    guarded("uefn_get_compile_errors", "read_project", async () =>
      engine.lastCompile ? ok(engine.lastCompile.diagnostics) : fail("no compile has run yet; call uefn_compile_verse"),
    ),
  );

  /** Event index at which the session started through this server; default profile window. */
  let sessionMark: { id: string; index: number } | undefined;

  // ── runtime ─────────────────────────────────────────────────────────────
  server.registerTool(
    "uefn_start_session",
    { description: "Launch (or reuse) a UEFN session and wait until the DevTools runtime reports ready." },
    guarded("uefn_start_session", "start_sessions", () =>
      lock.run(async () => {
        const before = engine.events.size;
        const previousId = sessionMark?.id;
        const session = await engine.startSession();
        if (session.id !== previousId) sessionMark = { id: session.id, index: before };
        await engine.waitForRuntime();
        return ok(session);
      }),
    ),
  );

  server.registerTool(
    "uefn_stop_session",
    { description: "Stop the current session." },
    guarded("uefn_stop_session", "start_sessions", () =>
      lock.run(async () => {
        await engine.stopSession();
        return ok({ stopped: true });
      }),
    ),
  );

  server.registerTool(
    "uefn_get_session_state",
    { description: "Session status, runtime readiness, game phase and team scores." },
    guarded("uefn_get_session_state", "read_project", async () =>
      ok({
        session: engine.session ?? null,
        runtimeReady: engine.runtimeReady,
        phase: engine.state.phase,
        round: engine.state.round,
        teams: engine.state.teams,
        events: engine.events.size,
      }),
    ),
  );

  for (const [name, type, description] of [
    ["uefn_start_game", "start_game", "Start the game in the running session."],
    ["uefn_stop_game", "end_game", "End the game in the running session."],
  ] as const) {
    server.registerTool(
      name,
      { description },
      guarded(name, "start_sessions", () =>
        lock.run(async () => {
          await engine.command({ type });
          return ok({ ok: true });
        }),
      ),
    );
  }

  // ── inspection ──────────────────────────────────────────────────────────
  server.registerTool(
    "uefn_get_players",
    { description: "All players known to the current session state." },
    guarded("uefn_get_players", "read_project", async () => ok(Object.values(engine.state.players))),
  );
  server.registerTool(
    "uefn_get_player",
    { description: "One player's live state.", inputSchema: { id: z.string() } },
    guarded("uefn_get_player", "read_project", async ({ id }: { id: string }) =>
      engine.state.players[id] ? ok(engine.state.players[id]) : fail(`unknown player '${id}'`),
    ),
  );
  server.registerTool(
    "uefn_get_devices",
    { description: "Devices: configured inventory plus live observed state." },
    guarded("uefn_get_devices", "read_project", async () => {
      const known = engine.session ? await engine.adapter.getDevices() : [];
      return ok({ inventory: known, observed: Object.values(engine.state.devices) });
    }),
  );
  server.registerTool(
    "uefn_get_device",
    { description: "One device's observed state.", inputSchema: { id: z.string() } },
    guarded("uefn_get_device", "read_project", async ({ id }: { id: string }) =>
      engine.state.devices[id] ? ok(engine.state.devices[id]) : fail(`device '${id}' has not been observed`),
    ),
  );

  // ── events ──────────────────────────────────────────────────────────────
  server.registerTool(
    "uefn_get_events",
    {
      description: "Query the session event log. Event types are dotted (score.changed); PascalCase (ScoreChanged) is accepted.",
      inputSchema: {
        type: z.string().optional(),
        trace_id: z.string().optional(),
        from_index: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(500).default(100),
      },
    },
    guarded(
      "uefn_get_events",
      "read_project",
      async (a: { type?: string; trace_id?: string; from_index?: number; limit: number }) => {
        const all = engine.events.query({
          ...(a.type ? { type: normalizeEventType(a.type) } : {}),
          ...(a.trace_id ? { traceId: a.trace_id } : {}),
          ...(a.from_index !== undefined ? { fromIndex: a.from_index } : {}),
        });
        return ok({ total: all.length, nextIndex: engine.events.mark(), events: all.slice(-a.limit) });
      },
    ),
  );

  server.registerTool(
    "uefn_trace_event",
    {
      description: "Causal chain for an event: follows parent links back to the root cause and shows everything it triggered.",
      inputSchema: { event_id: z.string() },
    },
    guarded("uefn_trace_event", "read_project", async ({ event_id }: { event_id: string }) => {
      const tree = engine.events.causalTree(event_id);
      if (!tree) return fail(`unknown event '${event_id}'`);
      return ok({ tree: formatCausalTree(tree), ancestry: engine.events.ancestry(event_id).map((e) => e.id) });
    }),
  );

  server.registerTool(
    "uefn_profile",
    {
      description:
        "Profile of the current session's events: throughput, hot event types, perf.span stats, perf.sample series and causal latency per parent->child edge (docs/profiler.md).",
      inputSchema: { from_index: z.number().int().nonnegative().optional() },
    },
    guarded("uefn_profile", "read_project", async ({ from_index }: { from_index?: number }) =>
      ok(buildProfile(engine.events.all(from_index ?? sessionMark?.index ?? 0))),
    ),
  );

  server.registerTool(
    "uefn_wait_for_event",
    {
      description: "Block until a matching event arrives (only events after the call), or time out.",
      inputSchema: {
        type: z.string(),
        match: z.record(z.string(), z.unknown()).optional(),
        timeout_ms: z.number().positive().max(600_000).default(10_000),
      },
    },
    guarded(
      "uefn_wait_for_event",
      "read_project",
      async (a: { type: string; match?: Record<string, unknown>; timeout_ms: number }) =>
        ok(
          await engine.waitForEvent(
            { type: normalizeEventType(a.type), ...(a.match ? { payload: a.match } : {}) },
            { timeoutMs: a.timeout_ms },
          ),
        ),
    ),
  );

  // ── tests ───────────────────────────────────────────────────────────────
  server.registerTool(
    "uefn_list_tests",
    { description: "Discovered gameplay tests (TypeScript and YAML)." },
    guarded("uefn_list_tests", "read_project", async () => {
      const { tests, errors } = await loadTests(await findTestFiles(resolve(engine.root, engine.config.paths.tests)));
      return ok({
        tests: filterTests(tests).map((t) => ({ id: t.id, name: t.name, file: relative(engine.root, t.file), format: t.format })),
        errors,
      });
    }),
  );

  const runSchema = {
    filter: z.string().optional().describe("substring of test id, name or file"),
    repeat: z.number().int().positive().max(1000).default(1).describe("run each test N times to measure reliability"),
    seed: z.number().int().optional(),
    compile: z.boolean().default(true).describe("compile Verse before running"),
  };
  const run = (a: { filter?: string; repeat: number; seed?: number; compile: boolean }) =>
    lock.run(async () =>
      ok(
        summarizeRun(
          await runTests(engine, {
            ...(a.filter ? { filter: a.filter } : {}),
            repeat: a.repeat,
            ...(a.seed !== undefined ? { seed: a.seed } : {}),
            skipBuild: !a.compile,
            keepSession: true,
          }),
        ),
      ),
    );
  server.registerTool(
    "uefn_run_test",
    {
      description: "Run the tests matching `filter` (compile → session → run → assert). Returns a deterministic verdict and artifact paths.",
      inputSchema: { ...runSchema, filter: z.string().describe("substring of test id, name or file") },
    },
    guarded("uefn_run_test", "run_tests", run),
  );
  server.registerTool(
    "uefn_run_tests",
    { description: "Run all tests (optionally filtered).", inputSchema: runSchema },
    guarded("uefn_run_tests", "run_tests", run),
  );

  server.registerTool(
    "uefn_create_test",
    {
      description:
        "Create a declarative YAML test under the project's tests directory. The YAML is validated against the test schema before it is written; existing files are not overwritten.",
      inputSchema: {
        file_name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "lower-case slug, no extension"),
        yaml: z.string(),
      },
    },
    guarded("uefn_create_test", "modify_project", async ({ file_name, yaml }: { file_name: string; yaml: string }) => {
      const parsed = YamlTestSchema.safeParse(parseYaml(yaml));
      if (!parsed.success) {
        return fail(`invalid test:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
      }
      const dir = resolve(engine.root, engine.config.paths.tests);
      const path = join(dir, `${file_name}.test.yaml`);
      if (await stat(path).then(() => true, () => false)) return fail(`${relative(engine.root, path)} already exists`);
      await mkdir(dir, { recursive: true });
      await writeFile(path, yaml.endsWith("\n") ? yaml : yaml + "\n");
      return ok({ created: relative(engine.root, path), test: parsed.data.name });
    }),
  );

  return server;
}
