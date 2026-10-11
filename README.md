# UEFN DevTools

A deterministic development and observability layer over UEFN. It exposes
project structure, runtime state, testing and verification through a shared
CLI and MCP interface, built on a single engine and state model.

The milestone is spec §87: **modify Verse, run one command, and know whether
a gameplay behaviour still works.**

```
$ uefn test capture-point-a
Compiling Verse...
Starting UEFN session...
Connected.
Waiting for runtime...

Running:
Capture Point A

✓ Game started
✓ player1 spawned on team 1
✓ player1 teleported to CapturePointA
✓ capture.completed observed
✓ CapturePointA state = Captured
✓ CapturePointA owner = Team 1
✓ Team 1 score = 50
✓ score.changed occurred 1×

PASS
Duration: 0.83s
```

## Status

| Area | State |
|---|---|
| Test runner: TS + YAML, lifecycle state machine, repeat/seed, failure correlation, artifacts | working |
| State snapshots (`toMatchSnapshot`, YAML `snapshot:`, `--update-snapshots`) | working |
| `--headed` live state view and `--debug` step debugger | working (UEFN sessions always launch the client, so `--headed` only matters for the simulator) |
| Engine: event store, derived state, causal traces, time-travel replay, git capture | working |
| SQLite persistence: sessions, events, runs, per-test history (`uefn history`) | working |
| Daemon: one shared engine and session over a local HTTP + SSE API | working |
| Desktop dashboard (`uefn ui`): live state, events, time travel, tests | working |
| VS Code extension: Test Explorer, Verse diagnostics, live events, YAML schema | working (verified in a VS Code 1.100 extension host) |
| Recorder (`uefn record`): observed session to a YAML test | working (scripted on the simulator; interactive needs real UEFN) |
| `uefn doctor` and `uefn deps` (Verse dependency graph, test impact) | working |
| Profiler (`uefn profile`, Chrome trace export, `uefn_profile` MCP tool) | working; Verse span and sample helpers verified in a live UEFN 42.30 session |
| GitHub: JUnit and Actions reporters, job summary, `init --github`, `ci comment` | working |
| CLI: `status`, `doctor`, `capabilities`, `compile`, `list`, `test`, `profile`, `trace`, `deps`, `record`, `history`, `daemon`, `ui`, `mcp`, `init`, `ci` | working |
| MCP server (21 tools, permission modes, audit log) | working |
| Simulated adapter: deterministic capture-point world with fault injection and perf samples | working |
| Log transport and compile-diagnostics parser | tested against real UEFN 41.10 editor logs; game start/end derived from the log |
| UEFN MCP adapter (compile, sessions, match start/stop) | POC-001 passes against a live UEFN 42.30 session ([evidence](docs/evidence/uefn-42.30-live.md)) |
| Verse runtime emitter (`runtime/verse`) | works in a live UEFN 42.30 session (`Hello`, probes, spans and samples reach the log) |
| Scenario devices (`uefn scenario`): player actions in a real match | teleport, damage, eliminate and acting after a respawn verified live on UEFN 42.30, in fresh and reused sessions |

Everything runs today against the **simulated adapter**. That covers
developing the engine, test API and agent loop. The same tests run
against real UEFN 42.30 through its MCP server: POC-001 (compile, launch,
detect the runtime, start and stop the match, observe and assert a Verse
value) passes live. [`docs/capabilities.md`](docs/capabilities.md) has the
evidence; player actions run through a generated in-game scenario device
([scenarios](docs/scenarios.md)), with teleport, damage and eliminate verified live.

## Quick start

```
pnpm install
pnpm build
cd examples/capture-point
node ../../apps/cli/dist/main.js test
node ../../apps/cli/dist/main.js test capture-point-a --repeat 100 --config uefn-devtools.flaky.yaml
```

The second run injects a 7% double-award fault. It shows reliability
measurement, failure correlation, and per-iteration artifacts that
`uefn trace` can explain:

```
player.entered_area (device=CapturePointA, player=player1, team=1)
└─ capture.started (device=CapturePointA, team=1)
   └─ capture.completed (device=CapturePointA, team=1)
      ├─ score.changed (team=1, delta=50)
      └─ score.changed (team=1, delta=50)
```

## Using it from an agent

```json
{
  "mcpServers": {
    "uefn-devtools": {
      "command": "node",
      "args": ["/path/to/uefn-devtools/apps/cli/dist/main.js", "mcp"],
      "cwd": "/path/to/your/island"
    }
  }
}
```

The loop the tools support is: `uefn_list_tests` → `uefn_create_test` →
`uefn_run_test` (with `repeat`) → `uefn_get_events` / `uefn_trace_event` →
edit Verse → `uefn_compile_verse` → `uefn_run_test`. Never report a change
as done until compile and the reproduction test both pass.

## Layout

```
apps/cli               uefn command
apps/desktop           dashboard served by the daemon (uefn ui)
apps/vscode            VS Code extension
packages/protocol      schemas: events, sessions, tests, config, wire format
packages/uefn          UEFNAdapter, RuntimeTransport, simulator, MCP adapter, log transport
packages/core          DevToolsEngine, event store, state reducer, git, audit, persistence,
                       recorder, profiler, doctor, deps graph
packages/test          test()/expect(), YAML tests, snapshots, runner, reporters, debug hooks
packages/daemon        DevToolsDaemon (HTTP + SSE) and DaemonClient
packages/mcp           MCP server
runtime/verse          in-game DevTools emitter
examples/capture-point example island config, Verse and tests
docs/                  architecture, protocol, tests, capabilities, and one page per feature
```

## Development

```
pnpm build        # tsc -b across the workspace
pnpm test         # build, then node:test suites
```

Requires Node >= 22.18 (type stripping is used to load `.test.ts` files) and pnpm 10.
