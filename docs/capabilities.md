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

> **Status (2026-10-09).** No live UEFN session has been driven by DevTools
> yet. Evidence so far comes from the UEFN install on the development machine:
> real editor logs from UEFN 41.10 (July 2026), which the log transport and
> the compile-diagnostics parser are now tested against, and strings in the
> UEFN 42.30 binaries, which show an official MCP server with session and
> Verse toolsets. *Binary evidence* means the capability exists in the shipped
> build but its tool names and behaviour have not been observed. Mark
> *Verified* only from a real session, and link the evidence (a
> `uefn capabilities --json` dump, a log excerpt).

## How to fill this in

1. Use UEFN 42.30 or later. Enable the **UEFN MCP Toolsets** beta setting in
   the editor settings (or run `ModelContextProtocol.StartServer <port>` in
   the editor console, or launch with
   `-ModelContextProtocolStartServer -ModelContextProtocolPort=N`). Run
   `ModelContextProtocol.GenerateClientConfig ClaudeCode` to get the URL, and
   set `mcp.url` (shape `http://localhost:<port>/mcp`).
2. Run `uefn capabilities --adapter mcp --json > docs/evidence/mcp-tools.json`.
   This connects, lists every tool the server exposes, and reports which
   DevTools operations are mapped. It also shows whether tools are listed
   directly or only through `list_toolsets` / `describe_toolset` /
   `call_tool` (the 42.30 binaries contain both modes).
3. Map the operations in `mcp.tools` (`compile`, `start_session`,
   `stop_session`, `session_state`, `project_info`, `start_game`, `end_game`)
   to real tool names. Names seen next to the 42.30 tool descriptions:
   `CompileVerse`, `StartSession`, `StopSession`, `GetSessionStatus`,
   `GetGameState`, `StartGame`, `StopGame`, `PushChanges`,
   `GetClientLogEntries` (unconfirmed).
   UEFN 42.30 runs in meta-tool mode (seen in a live editor log: "registered
   3 meta-tools", `list_toolsets` / `describe_toolset` / `call_tool`), so
   map an operation as `<toolset>/<tool>`, for example
   `start_game: ValkyrieToolset.SessionToolset/StartGame`. DevTools then sends
   it through `call_tool`, using the argument names `call_tool` publishes.
   `uefn capabilities` prints the `list_toolsets` output.
4. Set `runtime.log_path` to the editor log,
   `C:/Users/<you>/AppData/Local/UnrealEditorFortnite/Saved/Logs/UnrealEditorFortnite.log`
   (from WSL: `/mnt/c/Users/<you>/AppData/Local/...`). Runtime Verse `Print`
   output from play sessions lands there (seen in real logs).
5. Copy `runtime/verse/devtools.verse` into a test island, compile it, start a
   session, and confirm `[UEFN-DEVTOOLS]` lines reach that log. UEFN's own
   test code expects `bAutoStartGameOnLaunch=false` in
   `[/Script/ValkyrieEditor.ValkyrieEditorConfig]` so that live edits keep
   applying; with `start_game` mapped, DevTools starts the match itself.
6. Update the tables.

## Matrix

| Feature | Hypothesis | Mechanism | Evidence | Verified |
|---|---|---|---|---|
| Project discovery | DIRECT (filesystem) | `.uefnproject`, Verse and test files on disk | | ✅ (filesystem only) |
| Project info | DIRECT? | UEFN MCP tool → `mcp.tools.project_info`; no project-info tool identified, VerseToolset file listing is the closest | | ☐ |
| Compile Verse | DIRECT | VerseToolset "Compile all Verse code in the project" → `mcp.tools.compile` | binary (42.30) | ☐ |
| Compile diagnostics | DIRECT / DERIVED | structured `{severity, code, message, file, span}` (severities `Error`/`Warning`/`Information`/`Hint`, 0-indexed spans); fallback parses `VerseBuild: Error: <file>.verse(l,c, l2,c2): Script error <code>: <msg>`, de-duplicated | binary (42.30); log format real (41.10), parser tested on it | ☐ |
| Launch session | DIRECT | SessionToolset "Upload the open project and launch a play-in-client session" → `mcp.tools.start_session`; long operations return `Completed`/`Failed`/`StillRunning` | binary (42.30) | ☐ |
| Session status | DIRECT / DERIVED | `GetSessionStatus` (`Disconnected`/`Connecting`/`Connected`/`Reconnecting`/`UpdatingContent`) and `GetGameState` (`Unconnected`/`CanStart`/`Running`) | binary (42.30) | ☐ |
| Game start / end detection | DERIVED | log transport maps `MinigameStateChanged: EFortMinigameState::InProgress` → `game.started`, `::PostGameEnd` → `game.ended` | real logs (41.10), tested on ~117k lines | ✅ (log replay; not live) |
| Game start / end commands | DIRECT | SessionToolset `StartGame` / `StopGame` → `mcp.tools.start_game` / `end_game`, sent through the session transport | binary (42.30); adapter tested against a stdio MCP server | ☐ |
| Detect runtime ready | INSTRUMENTED | `devtools_emitter.Hello()` → `session.ready` | | ☐ |
| Structured logs | DERIVED | tail the editor log; `LogVerse` lines → `log` events with `level`, `channel` and `message` | real logs (41.10): Print, `log_channel` and warning shapes, BOM, CRLF | ✅ (log replay; not live) |
| Gameplay events | INSTRUMENTED | `devtools_emitter.Emit` → log → `RuntimeEvent` | wire records parse inside real LogVerse line shapes | ☐ |
| Probes (runtime values) | INSTRUMENTED | `devtools_emitter.Probe*` → `probe.updated` | as above | ☐ |
| Event causality | INSTRUMENTED | `DevToolsParent(seq)` / `DevToolsTrace(id)` fields | | ☐ |
| Player state (health, team…) | INSTRUMENTED | Verse reads `fort_character` and emits | | ☐ |
| Device state | INSTRUMENTED | Verse subscribes to device events and emits | | ☐ |
| Push changes | DIRECT | SessionToolset `PushChanges(bVerseOnly)` (not used by DevTools yet) | binary (42.30) | ☐ |
| Client log search | DIRECT | SessionToolset `GetClientLogEntries(Pattern, StartLine)` (not used yet) | binary (42.30) | ☐ |
| Player actions (teleport, damage…) | INSTRUMENTED (proposed) | in-game *scenario device* runs the steps (below); the Device and Entity toolsets edit the level, not the running match | binary (42.30) | ☐ |
| Screenshots | UNKNOWN | none found | | ☐ |
| Profiling: event throughput, causal latency, stage timings | DERIVED | `buildProfile` over the event log and runner stages (docs/profiler.md) | | ✅ (simulated only) |
| Profiling: scoped timings and runtime samples | INSTRUMENTED | `ProfileBegin` / `ProfileEnd` / `ProfileSpan` / `PerfSample` in `devtools.verse` → `perf.span` / `perf.sample`; time source `GetSimulationElapsedTime` (per-frame, so spans only measure work that suspends) | | ☐ |
| Profiling: memory, engine frame cost | UNKNOWN | no Verse API known for memory or engine timings | | ☐ |
| Headed session (`--headed`) | N/A for UEFN | every play session launches the Fortnite client (`Launching Client [0] using ...FortniteLauncher.exe`), so UEFN sessions are always headed; the flag only drives the simulator's live view | real logs (41.10) | ✅ (log evidence) |
| Headless execution | BLOCKED (inferred) | sessions always launch a real client; needs a Windows runner with UEFN + Fortnite (spec §40) | real logs (41.10) | ☐ |

## The command gap

The log transport only carries data **out** of the session. It cannot send
commands in. Until an inbound channel exists, steps such as `teleport` or
`eliminate` fail with an explicit `unsupported` error rather than a silent
skip. Any one of these options could close the gap. All are unverified:

1. **Official API.** Partly closed: UEFN 42.30 ships `StartGame` / `StopGame`
   session tools (binary evidence, unverified live), which DevTools sends when
   `mcp.tools.start_game` / `end_game` are mapped. No tool acts on players in
   the running match, so player actions still need option 2 or 3.
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
| 1 | Connect to UEFN | ✅ | ☐ `McpUefnAdapter.connect` to the 42.30 MCP server (`mcp.url`) |
| 2 | Compile Verse | ✅ (no-op) | ☐ `mcp.tools.compile` (VerseToolset); diagnostics parser tested on real errors |
| 3 | Launch session | ✅ | ☐ `mcp.tools.start_session` (SessionToolset) |
| 4 | Detect Fortnite ready | ✅ | ☐ `Hello()` + `runtime.log_path`; match start also derived from the log |
| 5 | Start game | ✅ | ☐ `mcp.tools.start_game` (SessionToolset `StartGame`) |
| 6 | Observe one Verse value | ✅ | ☐ `ProbeInt` |
| 7 | Trigger one controlled action | ✅ | ☐ command gap |
| 8 | Observe value change | ✅ | ☐ |
| 9 | Assert expected value | ✅ | ✅ (engine is transport-agnostic) |
| 10 | Return PASS/FAIL | ✅ | ✅ |
