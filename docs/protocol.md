# Protocol

## RuntimeEvent

Every observation is normalised to one shape (spec §52), whatever transport
produced it. The Zod schema is `RuntimeEvent` in `packages/protocol/src/events.ts`.

```json
{
  "id": "sim_29",
  "timestamp": 6600.4,
  "type": "score.changed",
  "source": { "type": "device", "id": "CapturePointA" },
  "target": { "type": "team", "id": "1" },
  "traceId": "tr_0002",
  "parentEventId": "sim_27",
  "payload": { "team": 1, "previous": 0, "current": 50, "delta": 50 }
}
```

`timestamp` is in milliseconds on the session clock. `parentEventId` links
an effect to its cause. `uefn trace` and `uefn_trace_event` follow these
links to build causal trees.

### Canonical event types

The state reducer (`packages/core/src/state.ts`) and the built-in assertions
understand these:

| Type | Payload |
|---|---|
| `session.ready` | `runtimeVersion` |
| `game.started` / `game.ended` | `winner?` |
| `player.spawned` | `player`, `team`, `health?`, `shield?`, `position?` |
| `player.moved` | `player`, `position` |
| `player.entered_area` / `player.exited_area` | `player`, `device` |
| `player.eliminated` | `player`, `by?` |
| `player.state_changed` | `player`, `health?`, `shield?`, `score?`, … |
| `device.state_changed` | `device`, `state?`, `enabled?`, `owner?`, `progress?` |
| `capture.started` / `capture.completed` | `device`, `team` |
| `score.changed` | `team`, `previous`, `current`, `delta` |
| `probe.updated` | `probe`, `value` |
| `log` | `category`, `level`, `message` |

Tests and MCP tools also accept PascalCase names: `CaptureCompleted` is
`capture.completed` and `PlayerEnteredArea` is `player.entered_area`.

## Runtime wire format

The format is line-oriented and written by `runtime/verse/devtools.verse`
into the UEFN output log:

```
[UEFN-DEVTOOLS]|1|<kind>|<seq>|<name>|<key[:type]=value>|...
```

| Part | Values |
|---|---|
| kind | `E` event · `P` probe (`v` holds the value) · `H` hello (runtime ready) |
| seq | emitter sequence number; the event id is `rt_<seq>` |
| type | `s` string (default) · `i` int · `f` float · `b` bool · `v` vector `x,y,z` |
| reserved keys | `src` / `tgt` (`kind:id`), `trace`, `parent` (sequence number) |

`%`, `|`, `=` and newlines are percent-encoded. A line that carries the
marker but cannot be parsed becomes a `log` event at level `error`, so it is
never dropped silently. JSON was rejected because Verse string literals
interpolate `{…}`.

```
[2026.10.04-13.24.11:123][456]LogVerse: [UEFN-DEVTOOLS]|1|E|7|score.changed|team:i=1|current:i=50|src=device:CapturePointA|parent=6
```

## RuntimeCommand

Commands go from DevTools to the runtime (`packages/protocol/src/commands.ts`):
`start_game`, `end_game`, `reset`, `seed`, `spawn_player`, `teleport`,
`leave_area`, `eliminate_player`, `damage_player`, `set_device_enabled`.
Each transport declares the subset it supports.

## Test lifecycle

`DISCOVERING → VALIDATING → BUILDING → STARTING_SESSION → WAITING_FOR_RUNTIME`
runs once per invocation. Each attempt then runs
`INITIALIZING → RUNNING → ASSERTING → COLLECTING → CLEANUP → PASSED | FAILED`.
Every transition is emitted as a `RunnerEvent` of kind `stage`. A failure
before any test runs ends the run as `error`, and `failedStage` names the
stage.

## Artifacts

Each run writes `<paths.results>/<date>/<runId>/summary.json`. Each failed
attempt also writes a directory containing `result.json`, `events.jsonl` (the
attempt's trace), `state.json`, `compile.json` and `session.json`.

## MCP tools

| Tool | Scope |
|---|---|
| `uefn_get_project`, `uefn_get_capabilities`, `uefn_get_session_state`, `uefn_get_compile_errors` | read_project |
| `uefn_get_players`, `uefn_get_player`, `uefn_get_devices`, `uefn_get_device` | read_project |
| `uefn_get_events`, `uefn_trace_event`, `uefn_wait_for_event`, `uefn_list_tests` | read_project |
| `uefn_compile_verse` | compile |
| `uefn_start_session`, `uefn_stop_session`, `uefn_start_game`, `uefn_stop_game` | start_sessions |
| `uefn_run_test`, `uefn_run_tests` | run_tests |
| `uefn_create_test` | modify_project |

Modes: `read_only` (read_project), `development` (everything except
modify_project; the default) and `full_access`. Every call, including denied
ones, is appended to `.devtools/audit.log`.
