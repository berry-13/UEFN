# DevTools daemon

The daemon (spec §83) wraps one `DevToolsEngine` and serves it over a local
HTTP API, so several clients (CLI, desktop app, VS Code extension, scripts)
share one engine, one session and one event log instead of each embedding
their own.

```
uefn daemon start [--port n] [--detach] [--ui]   # foreground until Ctrl+C, or background
uefn daemon status                         # exit 0 when running, 1 when not
uefn daemon stop                           # asks the daemon to shut down
```

`--adapter` and `--config` apply as for every other command. `--detach`
spawns a background process that logs to `.devtools/daemon.log` and returns
once `daemon.json` appears (30s timeout). `--ui` also serves the desktop
dashboard under `/` (see [desktop.md](desktop.md)). Only one live daemon may serve a
project; a second `start` fails while the first is alive.

Package: `@uefn-devtools/daemon` (`DevToolsDaemon`, `DaemonClient`,
`readDaemonInfo`). The client alone is importable from
`@uefn-devtools/daemon/client` and only needs global `fetch`.

## Discovery: `.devtools/daemon.json`

Written atomically on start with mode `0600` (it holds the token), removed on
stop.

```json
{ "pid": 41231, "port": 43123, "token": "<base64url>", "root": "/path/to/project", "startedAt": 1791566525656, "version": "0.1.0", "ui": true }
```

`ui` is true when the daemon serves the dashboard (it was started with a
`staticDir`, e.g. `uefn daemon start --ui`).

`readDaemonInfo(root)` returns the file plus `stale: true` when `pid` is no
longer running (a crashed daemon). `DaemonClient.fromRoot(root)` refuses a
stale file; `uefn daemon stop` removes one; `start` overwrites one.

## Security

- Listens on `127.0.0.1` only. The port is ephemeral unless `--port` is set.
- Every `/api/*` request needs `Authorization: Bearer <token>`; anything
  else gets `401`. Static files (below) are the only exception. The token is 32 random bytes generated at start and compared in
  constant time.
- `GET /api/stream` additionally accepts `?token=` because `EventSource`
  cannot set headers. No other route reads the query token.
- The `Host` header must be `127.0.0.1` or `localhost` (any port), otherwise
  `403`. This blocks DNS rebinding from a browser page.
- No CORS headers are sent, so other origins cannot read responses.
- Mutating calls (`compile`, `session/start`, `session/stop`, `tests/run`,
  `shutdown`) are appended to `.devtools/audit.log` with action
  `daemon.<name>` and the actor from the optional `X-DevTools-Client` header
  (default `daemon-client`).
- Session-mutating calls run one at a time behind a mutex; reads never wait.

## Endpoints

All responses are JSON. Errors are `{ "error": "<message>" }` with status
`400` (bad parameters or body), `401`, `403`, `404`, `405`, `413` (body over
1 MiB) or `500`.

| Method | Path | Response |
|---|---|---|
| GET | `/api/status` | `StatusResponse` |
| GET | `/api/state` | live `GameState` |
| GET | `/api/state/at?index=N` | `{ index, timestamp, state }` |
| GET | `/api/events?type=&traceId=&fromIndex=&limit=` | `{ events, nextIndex, size }` |
| GET | `/api/events/:id/trace` | `{ tree, ancestry, text }` |
| GET | `/api/tests` | `{ tests, errors }` |
| GET | `/api/capabilities` | adapter `CapabilityReport` |
| POST | `/api/compile` | `CompileResult` |
| POST | `/api/session/start` | `Session` (after the runtime reports ready) |
| POST | `/api/session/stop` | `{ stopped: true }` |
| POST | `/api/tests/run` | `RunSummary` |
| POST | `/api/shutdown` | `{ stopping: true }`, then the process exits |
| GET | `/api/stream` | Server-Sent Events, see below |

### `GET /api/status`

```json
{
  "project": "CapturePoint", "root": "/path/to/project", "adapter": "simulated",
  "session": { "id": "sim-session-1", "status": "connected", "...": "..." },
  "runtimeReady": true, "phase": "ended", "events": 60, "busy": false,
  "daemon": { "pid": 41231, "port": 43123, "startedAt": 1791566525656, "version": "0.1.0", "streams": 1, "ui": true }
}
```

`session` is `null` before the first session. `busy` is true while a
compile, session change or test run holds the lock. `streams` counts open
SSE connections. `ui` mirrors the field in `daemon.json`.

### `GET /api/state/at?index=N`

Time travel. Replays `events[0..N]` (inclusive) through `applyEvent` into an
empty `GameState`. `N` must be in `[0, size)`; `timestamp` is that event's
session-clock time. Note that the live state (`/api/state`) is reset at the
start of each test, while the replay always starts from the beginning of the
log, so the two can differ.

### `GET /api/events`

- `type`: one event type or a comma-separated list; PascalCase
  (`ScoreChanged`) is accepted.
- `traceId`: only events of one trace.
- `fromIndex` (default `0`), `limit` (default `100`, max `1000`).

Returns matches in log order, each with its store `index`. `nextIndex` is
where to continue (pass it as the next `fromIndex`); `size` is the log
length.

### `GET /api/events/:id/trace`

The causal tree rooted at the earliest ancestor of `:id` (`CausalNode`), the
root-to-event `ancestry` ids, and `text`, the tree as `uefn trace` prints it.
`404` for an unknown id.

### `POST /api/tests/run`

```json
{ "filter": "capture", "repeat": 1, "seed": 7, "compile": true }
```

All fields optional (`repeat` defaults to 1, max 1000; `compile` defaults to
true). Runs with `keepSession: true`, so the session stays up and is shared
with every other client. Returns the full `RunSummary`; progress is
streamed as `runner` events.

## Server-Sent Events: `GET /api/stream`

```
GET /api/stream?token=<token>[&fromIndex=N]
```

| Event | Data | Notes |
|---|---|---|
| `runtime` | `RuntimeEvent & { index }` | Every event appended to the log. The SSE `id` is the store index. |
| `runner` | `RunnerEvent` | Progress from `runTests` (`stage`, `discovered`, `session`, `attempt`, `test`, `done`). In `attempt`, `test` is reduced to `{ id, name, file }`. |
| `session` | `{ session, runtimeReady, phase }` | Sent on connect and whenever the snapshot changes (session start/stop, runtime ready, game start/end, runner session). |

A comment line (`: heartbeat`) is sent every 15 seconds to keep proxies and
idle timers from closing the connection.

Replay: with `?fromIndex=N`, or with a `Last-Event-ID` header (which
`EventSource` sends on reconnect), the stream first replays `runtime` events
from that point, so a reconnecting client misses nothing.

## Static files

`new DevToolsDaemon({ engine, staticDir })` serves files from `staticDir`
under `/` for `GET`/`HEAD` (directories serve `index.html`). Paths are
decoded, resolved and checked against the real path of the root, so `..`
and symlinks cannot escape it. Static files are served **without** the bearer
token: they hold no secrets, and a browser window cannot attach a header to
its first navigation. The dashboard receives the token in the URL fragment
(`/#token=...`, never sent to the server) and uses it for `/api/*` and the
stream, which still require it. The Host check still applies, and responses
carry `Content-Security-Policy: default-src 'self'; frame-ancestors 'none';
base-uri 'none'; form-action 'none'` and `Referrer-Policy: no-referrer`.
`/api/*` always takes precedence; without a `staticDir`, non-API paths need
the token and answer `404`.

## `DaemonClient`

```ts
import { DaemonClient } from "@uefn-devtools/daemon/client";

const client = await DaemonClient.fromRoot(projectRoot, "vscode");
await client.status();
await client.state();
await client.stateAt(42);
await client.events({ type: "ScoreChanged", fromIndex: 0, limit: 100 });
await client.trace(eventId);
await client.tests();
await client.capabilities();
await client.compile();
await client.startSession();
await client.stopSession();
await client.runTests({ filter: "capture", repeat: 10, seed: 1 });
await client.shutdown();

client.streamUrl(fromIndex);                 // for a browser EventSource
await client.stream((m) => console.log(m.event, m.data), { signal, fromIndex, onOpen });
```

`DaemonClient.fromInfo(info, client?)` and `new DaemonClient({ url, token, client })`
build one directly. Failed calls throw `DaemonClientError` with the HTTP
`status` and the server's error message.
