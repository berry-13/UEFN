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
| Engine: event store, derived state, causal traces, time-travel replay, git capture | working |
| CLI: `status`, `capabilities`, `compile`, `test`, `doctor`, `trace`, `record`, `recordings`, `generate-test`, `mcp`, `daemon`, `init` | working |
| MCP server (25 tools, permission modes, audit log), over stdio or HTTP | working |
| Daemon: one shared engine for CLI, dashboard and agents (JSON-RPC, SSE, MCP over HTTP) | working |
| Dashboard: tests, live runs, run history, event timeline with causal chains, runtime state | working (browser; Tauri shell not started) |
| Simulated adapter: deterministic capture-point world with fault injection | working |
| UEFN MCP adapter + log-file transport | written, **not yet verified against UEFN** |
| Verse runtime emitter (`runtime/verse`) | written, **not yet compiled in UEFN** |
| Recorder: record a session → generated test (YAML/TS); bug recordings with anomaly report | working ([docs](docs/recorder.md)) |
| Project Doctor: static Verse analysis (17 rules) + test/setup checks, CI-gating exit code | working ([docs](docs/doctor.md)) |
| Deps graph, profiler, desktop (Tauri) shell | not started |

Everything runs today against the **simulated adapter**. That covers
developing the engine, test API and agent loop. It does not prove the
product's main risk, which is runtime observability inside real Fortnite.
[`docs/capabilities.md`](docs/capabilities.md) lists what has to be checked,
how to check it, and the open gap: there is no known channel for sending
commands into a running session.

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

## Dashboard and daemon

```
cd examples/capture-point
node ../../apps/cli/dist/main.js daemon
#   Dashboard  http://127.0.0.1:4917/#token=…
#   MCP        http://127.0.0.1:4917/mcp
```

The daemon holds one engine and session. The dashboard, `uefn test --daemon`,
and agents connected to `/mcp` all share it. A run started by any of them
appears live everywhere, and run history persists in `.devtools/results`. The
daemon binds 127.0.0.1 only, requires the bearer token on every data route,
and rejects foreign `Host`/`Origin` headers.

## Using it from an agent

Over HTTP through the daemon, so the dashboard shows what the agent does:

```
export UEFN_DEVTOOLS_TOKEN=$(openssl rand -base64 32)   # stable across restarts
uefn daemon &
claude mcp add --transport http uefn-devtools http://127.0.0.1:4917/mcp \
  --header "Authorization: Bearer $UEFN_DEVTOOLS_TOKEN"
```

Or over stdio, as a private engine:

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
packages/protocol      schemas: events, sessions, tests, config, wire format
packages/uefn          UEFNAdapter, RuntimeTransport, simulator, MCP adapter, log transport
packages/core          DevToolsEngine, event store, state reducer, git, audit
packages/test          test()/expect(), YAML tests, runner, reporter
packages/mcp           MCP server
packages/doctor        Project Doctor: Verse scanner and rules
packages/daemon        daemon (JSON-RPC, SSE, MCP over HTTP) and the dashboard
runtime/verse          in-game DevTools emitter
examples/capture-point example island config, Verse and tests
docs/                  architecture, protocol, tests, recorder, doctor, capabilities
```

## Development

```
pnpm build        # tsc -b across the workspace
pnpm test         # build, then node:test suites
```

Requires Node ≥ 22.18 (type stripping is used to load `.test.ts` files) and pnpm 10.
