# Capability matrix

Spec §78 calls for this matrix before the test engine grows further.
Runtime observability is the main technical risk. Every planned feature is
classified as:

| Class | Meaning |
|---|---|
| **DIRECT** | Available through an official UEFN API or MCP tool |
| **INSTRUMENTED** | Possible through generated or supplied Verse (`runtime/verse`) |
| **DERIVED** | Inferred from events or data DevTools already has |
| **BLOCKED** | Not possible under current UEFN APIs |
| **UNKNOWN** | Not investigated yet |

> **Status (2026-10-04): nothing below has been verified against a real
> UEFN install.** The *Hypothesis* column is a design assumption and has not
> been observed. Update *Verified* only from a real session, and link the
> evidence (a `uefn capabilities --json` dump, a log excerpt).

## How to fill this in

1. Point `mcp.command` (or `mcp.url`) in `uefn-devtools.config.yaml` at the UEFN MCP server.
2. Run `uefn capabilities --adapter mcp --json > docs/evidence/mcp-tools.json`.
   This connects, lists every tool the server exposes, and reports which
   DevTools operations are mapped.
3. Map the operations in `mcp.tools` (`compile`, `start_session`,
   `stop_session`, `session_state`, `project_info`) to real tool names.
4. Copy `runtime/verse/devtools.verse` into a test island, compile it, start a
   session, and confirm `[UEFN-DEVTOOLS]` lines reach the file named in
   `runtime.log_path`.
5. Update the tables.

## Matrix

| Feature | Hypothesis | Mechanism | Verified |
|---|---|---|---|
| Project discovery | DIRECT (filesystem) | `.uefnproject`, Verse and test files on disk | ✅ (filesystem only) |
| Project info | DIRECT? | UEFN MCP tool → `mcp.tools.project_info` | ☐ |
| Compile Verse | DIRECT? | UEFN MCP tool → `mcp.tools.compile` | ☐ |
| Compile diagnostics | DIRECT? / DERIVED | structured result, else parsed `file.verse(l,c): error` lines | ☐ |
| Launch session | DIRECT? | UEFN MCP tool → `mcp.tools.start_session` | ☐ |
| Session status | DIRECT? | UEFN MCP tool → `mcp.tools.session_state` | ☐ |
| Detect runtime ready | INSTRUMENTED | `devtools_emitter.Hello()` → `session.ready` | ☐ |
| Structured logs | INSTRUMENTED / DERIVED | tail output log; `LogVerse` lines → `log` events | ☐ |
| Gameplay events | INSTRUMENTED | `devtools_emitter.Emit` → log → `RuntimeEvent` | ☐ |
| Probes (runtime values) | INSTRUMENTED | `devtools_emitter.Probe*` → `probe.updated` | ☐ |
| Event causality | INSTRUMENTED | `DevToolsParent(seq)` / `DevToolsTrace(id)` fields | ☐ |
| Player state (health, team…) | INSTRUMENTED | Verse reads `fort_character` and emits | ☐ |
| Device state | INSTRUMENTED | Verse subscribes to device events and emits | ☐ |
| Game start / end commands | UNKNOWN | external → session channel not identified | ☐ |
| Player actions (teleport, damage…) | INSTRUMENTED (proposed) | in-game *scenario device* runs the steps (below) | ☐ |
| Screenshots | UNKNOWN | — | ☐ |
| Profiling: event throughput, causal latency, stage timings | DERIVED | `buildProfile` over the event log and runner stages (docs/profiler.md) | ✅ (simulated only) |
| Profiling: scoped timings and runtime samples | INSTRUMENTED | `ProfileBegin` / `ProfileEnd` / `ProfileSpan` / `PerfSample` in `devtools.verse` → `perf.span` / `perf.sample`; time source `GetSimulationElapsedTime` (per-frame, so spans only measure work that suspends) | ☐ |
| Profiling: memory, engine frame cost | UNKNOWN | no Verse API known for memory or engine timings; UEFN memory/perf tooling, possibly MCP | ☐ |
| Headed session (`--headed`) | UNKNOWN | `headed: true` forwarded to `mcp.tools.start_session`; effect depends on the UEFN tool | ☐ |
| Headless execution | likely BLOCKED | needs a Windows runner with UEFN + Fortnite (spec §40) | ☐ |

## The command gap

The log transport only carries data **out** of the session. It cannot send
commands in. Until an inbound channel exists, steps such as `teleport` or
`eliminate` fail with an explicit `unsupported` error rather than a silent
skip. Any one of these options could close the gap. All are unverified:

1. **Official API.** UEFN MCP exposes session commands. This would make them DIRECT.
2. **Scenario device (INSTRUMENTED).** DevTools generates a Verse device from
   the test definition into `/DevTools/generated/`. When the game starts, the
   device drives the developer's own player (`fort_character.TeleportTo`,
   damage, etc.) through the steps. Selecting a test means recompiling with
   a different generated scenario. This is slower, but it uses only
   supported APIs.
3. **Manual + recorder.** The developer performs the actions while DevTools
   observes and asserts. This is useful immediately, and it seeds the recorder.

The simulated adapter implements every command, so the engine, the test API
and the agent loop can be developed in the meantime.

## POC-001 checklist (spec §79)

| # | Step | Simulated | Real UEFN |
|---|---|---|---|
| 1 | Connect to UEFN | ✅ | ☐ `McpUefnAdapter.connect` |
| 2 | Compile Verse | ✅ (no-op) | ☐ needs `mcp.tools.compile` |
| 3 | Launch session | ✅ | ☐ needs `mcp.tools.start_session` |
| 4 | Detect Fortnite ready | ✅ | ☐ needs `Hello()` + `runtime.log_path` |
| 5 | Start game | ✅ | ☐ command gap |
| 6 | Observe one Verse value | ✅ | ☐ `ProbeInt` |
| 7 | Trigger one controlled action | ✅ | ☐ command gap |
| 8 | Observe value change | ✅ | ☐ |
| 9 | Assert expected value | ✅ | ✅ (engine is transport-agnostic) |
| 10 | Return PASS/FAIL | ✅ | ✅ |
