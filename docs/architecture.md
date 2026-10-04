# Architecture

```
 CLI (apps/cli)      MCP server (packages/mcp)      [desktop — later]
        │                     │
        └──────────┬──────────┘
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
- **In-process engine for the MVP.** CLI and MCP each embed an engine. The
  daemon from spec §83 (several clients sharing one session) is the next
  structural step. `DevToolsEngine` is already the boundary it would wrap.
- **No arbitrary execution through MCP.** There is no shell tool. The only
  write is `uefn_create_test`, which validates the YAML, can write only a
  slug-named file inside the tests directory, and never overwrites.

## Not built yet

These spec features are not implemented: desktop app, VS Code extension,
daemon, SQLite persistence (artifacts are JSON/JSONL), recorder, doctor,
dependency graph, profiler, snapshots, GitHub integration, `--headed` and
`--debug`.
