# Architecture

```
 CLI (apps/cli)   Dashboard (browser)   Agent (MCP over HTTP)   Agent (MCP stdio)
        │                 │                    │                      │
        │        ┌────────┴────────────────────┘                      │
        │        ▼                                                    │
        │   Daemon (packages/daemon)  /rpc · /stream · /mcp · /       │
        │        │                                                    │
        └────────┴──────────────────┬─────────────────────────────────┘
                                    ▼
          DevToolsEngine (packages/core)
          ├── EventStore      append-only RuntimeEvent log, queries, causal trees
          ├── GameState       derived by applyEvent(); replayable (stateAt)
          ├── Session         lifecycle + git info
          └── UEFNAdapter ────────────────────────────┐
                   ▲                                   │
     Test runner (packages/test)                       ▼
     test()/expect(), YAML, lifecycle        packages/uefn
                                             ├── SimulatedAdapter  (reference world)
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
| `@uefn-devtools/core` | `DevToolsEngine`: config, project discovery, git capture, event store, state reducer, waits, audit log. |
| `@uefn-devtools/test` | Playwright-style test API, YAML tests, runner state machine, reporter, failure correlation, artifacts. |
| `@uefn-devtools/mcp` | MCP tools over the engine, with permission scopes and an audit trail. |
| `@uefn-devtools/daemon` | Shared engine over HTTP on 127.0.0.1: JSON-RPC, server-sent events, MCP (Streamable HTTP) and the dashboard. |
| `@uefn-devtools/cli` | `uefn` command. |

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
- **Engine in process, or shared through the daemon.** `uefn test` and
  `uefn mcp` embed a private engine. `uefn daemon` hosts one engine for every
  client (spec §83). Every session-touching operation goes through
  `engine.exclusive()`, so an agent's run and a dashboard click queue rather
  than interleave. Runner progress is published on the engine
  (`publishActivity`), so a run is visible wherever it was started.
- **Dashboard without a build step.** Static HTML and JavaScript served by the
  daemon under a strict CSP. Runtime data comes from game logs and is
  untrusted, so it is rendered with `textContent` only. A Tauri desktop shell
  can load the same page later.
- **Long-lived processes re-import edited tests.** Node caches ES modules,
  so the runner caches definitions per test file and re-imports a file
  (cache-busted) only when its mtime changes.
- **No arbitrary execution through MCP.** There is no shell tool. The only
  write is `uefn_create_test`, which validates the YAML, can write only a
  slug-named file inside the tests directory, and never overwrites.

## Not built yet

These spec features are not implemented: Tauri desktop shell, VS Code extension,
SQLite persistence (artifacts are JSON/JSONL), recorder, doctor,
dependency graph, profiler, snapshots, GitHub integration, `--headed` and
`--debug`.
