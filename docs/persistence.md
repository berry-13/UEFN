# SQLite persistence

Sessions, events and test runs are mirrored into a SQLite database so history survives across processes. The in-memory `EventStore` and the JSON/JSONL artifacts under `paths.results` are unchanged; the database is an additional sink plus a query layer.

It uses the built-in `node:sqlite` module (no native dependency). On Node 22.x the module prints an `ExperimentalWarning`; `persistence.ts` drops only that warning, only while loading the module. Nothing is loaded when persistence is disabled.

## Configuration

```yaml
persistence:
  enabled: true                  # default
  path: ./.devtools/devtools.db  # relative to the config root
```

`.devtools/` is gitignored. The database runs in WAL mode, so `devtools.db-wal` and `devtools.db-shm` appear next to it while open.

## Write path

- `DevToolsEngine.db` is a `DevToolsDatabase` when enabled.
- `startSession` inserts the session row. If a different session already owns the adapter's id (the simulator always yields `sim-session-1`), the id gets a start-time suffix.
- Every event is queued and written in one transaction on a 100 ms timer, before any query, in `stopSession` and in `close`.
- `stopSession` records `status` and `endedAt`; `game.started` and `game.ended` also refresh the session row.
- `runTests` calls `engine.db.recordRun(summary, { gitCommit, gitBranch })` after writing `summary.json`. Failures there are swallowed so history never fails a run. Both the CLI and the MCP `run_tests` path go through the runner, so both are recorded.

## Schema (version 1)

Migrations are an ordered list in `persistence.ts`; applied versions are rows in `schema_version`. Append new migrations, never edit old ones.

| Table | Key | Notes |
|---|---|---|
| `sessions` | `id` | Session fields; `git_json` holds `GitInfo`. Index on `started_at`. |
| `events` | `(session_id, idx)` | `idx` is per session, starting at 0. Columns for type, source/target type and id, `trace_id`, `parent_event_id`, `payload` (JSON). Indexes on `type`, `trace_id`, `(session_id, id)`. |
| `runs` | `run_id` | RunSummary columns plus `git_commit`, `git_branch`, test counts and the full summary as `json`. |
| `test_results` | `(run_id, test_id)` | `status`, `reliability`, `passed`, `failed`, full `TestResult` as `json`. Index on `test_id`. |

## Queries

`DevToolsDatabase` (exported from `@uefn-devtools/core`):

- `listSessions({ limit })`, `getSession(id)`
- `eventsForSession(id, { type, limit, fromIndex })`
- `listRuns({ limit })`, `getRun(runId)`
- `testHistory(testId, { limit })`: entries newest first, `failRate`, `flakinessRate` (share of runs with `0 < reliability < 1`), `flips` (pass/fail changes between consecutive runs)
- `loadEventStore(sessionId)`: rebuilds an `EventStore`, so `causalTree`, `ancestry` and `stateAt` work on a past session
- `prune(timestamp)`: deletes sessions, events, runs and test results started before `timestamp`

CLI:

```
uefn history                     recent runs (status, tests, duration, git commit)
uefn history <test-id>           per-test history and reliability trend
uefn history --sessions          recorded sessions
uefn trace <event-id> --session <id>
```

All accept `--json`; `history` also takes `--limit <n>`.

## Retention

Nothing is deleted automatically. Event volume is the main cost (roughly one row per runtime event). Call `prune(Date.now() - 30 * 86_400_000)` to drop anything older than 30 days; run `VACUUM` afterwards to shrink the file. Deleting the database file is always safe: it is recreated on the next run.
