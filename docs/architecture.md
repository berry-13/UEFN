# Architecture

```
 Desktop UI (apps/desktop)   VS Code (apps/vscode)
            │ HTTP + SSE              │ HTTP + SSE / CLI --json
            └────────────┬────────────┘
                         ▼
 CLI (apps/cli)   Daemon (packages/daemon)   MCP server (packages/mcp)
        │                │                          │
        └────────────────┼──────────────────────────┘
                         ▼
          DevToolsEngine (packages/core)
          ├── EventStore      append-only RuntimeEvent log, queries, causal trees
          ├── GameState       derived by applyEvent(); replayable (stateAt)
          ├── Session         lifecycle + git info
          ├── DevToolsDatabase  SQLite sink: sessions, events, runs, history
          └── UEFNAdapter ────────────────────────────┐
                   ▲                                   │
     Test runner (packages/test)                       ▼
     test()/expect(), YAML, snapshots,       packages/uefn
     lifecycle, reporters, debug hooks       ├── SimulatedAdapter  (reference world)
                                             └── McpUefnAdapter    (UEFN MCP + log transport)
                                                       │
                                                       ▼
                                                 UEFN / Fortnite
                                             runtime/verse/devtools.verse
```

## Packages

| Package | Responsibility |
|---|---|
| `@uefn-devtools/protocol` | Zod schemas and types: events, traces, sessions, probes, test results, config, runtime wire format. No I/O. |
| `@uefn-devtools/uefn` | `UEFNAdapter` and `RuntimeTransport` interfaces, plus implementations: simulator, UEFN MCP client, log-file transport. All Epic-specific code lives here. |
| `@uefn-devtools/core` | `DevToolsEngine`: config, project discovery, git capture, event store, state reducer, waits, audit log, SQLite persistence ([persistence](persistence.md)), recorder ([recorder](recorder.md)), profiler ([profiler](profiler.md)), doctor ([doctor](doctor.md)), Verse dependency graph ([deps](deps.md)). |
| `@uefn-devtools/test` | Playwright-style test API, YAML tests, state snapshots, runner state machine, console/JUnit/GitHub reporters ([github](github.md)), failure correlation, artifacts, debug hooks and headed view ([debugging](debugging.md)). |
| `@uefn-devtools/daemon` | `DevToolsDaemon`: one engine behind a token-protected HTTP + SSE API on 127.0.0.1, and `DaemonClient` ([daemon](daemon.md)). |
| `@uefn-devtools/mcp` | MCP tools over the engine, with permission scopes and an audit trail. |
| `@uefn-devtools/cli` | `uefn` command; each subcommand is a module in `apps/cli/src/commands/`. |
| `@uefn-devtools/desktop` | Dashboard served by the daemon and opened by `uefn ui` in an app window ([desktop](desktop.md)). |
| `uefn-devtools-vscode` | VS Code extension over the CLI and the daemon ([vscode](vscode.md)). |

## Decisions

- **One state model.** All clients read `GameState`, which is derived purely
  from `RuntimeEvent`s. Recordings, time travel and artifact replay all reuse
  the reducer, with no second source of truth.
- **The adapter owns the clock.** Timeouts and timestamps use the adapter's
  `Clock`. The simulator runs faster than real time (`time_scale`) without
  changing what a test means.
- **Commands are a capability, not an assumption.** `RuntimeTransport.supportedCommands()`
  is explicit. A test step the transport cannot perform fails loudly
  (see [capabilities](capabilities.md#the-command-gap)).
- **Settled assertions.** State assertions must hold for `tests.expect_settle`
  (default 250ms of session time) after they first match. A score that reads
  50 and then 100 because a second scoring path fired is a failure, not a
  pass.
- **Deterministic simulation.** Simulator faults use a seeded PRNG. Iteration
  *i* of `--repeat` uses seed `seed + i`, so a failing iteration can be
  re-run exactly.
- **One engine per process, shared through the daemon.** CLI and MCP still
  embed an engine; the daemon (spec §83) wraps one so the dashboard, the
  editor and scripts share a single session. It binds 127.0.0.1, checks the
  Host header and a bearer token, and serialises session-mutating calls.
- **SQLite is a sink, not a second source of truth.** The in-memory
  `EventStore` stays authoritative during a session; `node:sqlite` (no native
  dependency) records sessions, events and runs so history, flakiness and
  traces of past sessions can be queried and replayed through the same
  reducer.
- **The desktop app is a local web app.** The daemon serves it and `uefn ui`
  opens it in a chromeless browser window; there is no Electron or Tauri
  shell. The URL carries a single-use launch ticket, never the token.
- **Diagnostics run no project code by default.** `uefn doctor` parses YAML
  tests only; importing TypeScript tests and launching `mcp.command` need
  `--deep`. The VS Code extension does not run in untrusted workspaces.
- **No arbitrary execution through MCP.** There is no shell tool. The only
  write is `uefn_create_test`, which validates the YAML, can write only a
  slug-named file inside the tests directory, and never overwrites.

## Open

Every feature on the original roadmap is built and runs against the
simulated adapter. What is left needs a Windows machine with UEFN and
Fortnite, so none of it can be checked from this repository alone:

- Player actions in a running match (teleport, damage, eliminate): UEFN's
  MCP tools start and stop matches but none acts on players, so the scenario
  device (option 2 in [capabilities](capabilities.md#the-command-gap)) is
  still needed. POC-001 itself passes live
  ([evidence](evidence/uefn-42.30-live.md)).
- Whether the Verse profiling helpers produce useful spans.
- Interactive `uefn record` with a human player.
- A native desktop shell, if a browser app window turns out not to be enough.
