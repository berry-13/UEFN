# Desktop app (DevTools dashboard)

The desktop app is a local web app served by the [daemon](daemon.md) and
opened in a chromeless app window. There is no Electron or Tauri shell: any
Chromium-family browser provides the window, and like every other client the
dashboard reads the one `GameState` the engine derives from runtime events.

```
uefn ui [--no-open] [--port n]
```

- If a live daemon for the project already serves the UI, `uefn ui` reuses it.
- If none is running, it starts a detached one with the UI (the same as
  `uefn daemon start --detach --ui`), logging to `.devtools/daemon.log`.
- If a daemon is running **without** the UI, it stops with a message: run
  `uefn daemon stop` first (stopping someone else's shared session is not
  done implicitly), or start daemons with `--ui`.
- It then asks the daemon for a launch ticket and opens
  `http://127.0.0.1:<port>/#ticket=<ticket>` in an app window and
  prints the URL. `--no-open` only prints it. `--json` prints
  `{ url, pid, port, opened }`.

Window selection, first match wins:

| Platform | Tried |
|---|---|
| Linux | `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge` on `PATH` with `--app=<url>`, then `xdg-open` |
| WSL | the Linux browsers above first (they share the loopback interface), then Windows Chrome or Edge under `/mnt/c/Program Files*` with `--app`, then `wslview`, then `xdg-open` |
| macOS | Google Chrome, Microsoft Edge, Chromium in `/Applications` with `--app`, then `open` |
| Windows | Chrome or Edge under `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%` with `--app`, then `start` |

`--port` and the global `--adapter` / `--config` are passed to a daemon that
`uefn ui` starts.

## Token handling

Static assets are served without the token (see "Static files" in
[daemon.md](daemon.md)); every API call and the event stream still need it.
The URL holds a launch ticket, not the token: it is single-use and expires
after 60 seconds, so the copy left on the browser's command line, in the
terminal or in shell history is worthless once the page has loaded. On load
the dashboard removes the ticket from the address bar with
`history.replaceState`, trades it at `POST /api/ui/exchange` for the token,
and keeps the token in `sessionStorage` (so a reload in the same window works;
failures to store are ignored and the in-memory copy is used). If the ticket
or token is missing or rejected (for example after the daemon restarted with
a new token), the connection status says so; run `uefn ui` again for a fresh
ticket.

## Views

All views share the session bar and one SSE connection (`/api/stream`).

- **Session bar**: project, adapter, session id and status, runtime ready,
  game phase, event count, and the connection state (an `aria-live` status).
  Compile, Start session and Stop session call the matching `POST` endpoints;
  while one runs its button shows a busy label and the others are disabled.
  Results are announced in a status line, failures in an alert.
- **Live state**: teams and scores, devices (state, owner, enabled, capture
  progress as `<progress>`, trigger count), players (team, alive, health,
  shield, score, eliminations, deaths, areas) and probes. Every `runtime` or
  `session` stream event schedules a re-fetch of `/api/state`, throttled to
  4 per second, so the view always shows the engine's own derived state.
- **Events**: the newest 2000 events stay in memory and the newest 250
  matches are rendered, newest first. Filter by type, search by id, type,
  entity, trace id or payload text, and pause rendering (events keep
  arriving and the count of new ones is shown). Selecting an event shows its
  fields, its payload and its causal tree from `/api/events/:id/trace`;
  every node of the tree can be selected in turn.
- **Time travel**: a slider over event indices. Moving it (or Previous /
  Next event) turns Live off and shows `/api/state/at?index=N`, the state
  replayed up to that event; checking Live follows the live state again.
  The replay starts at the first event of the log while the live state is
  reset at the start of each test, so the two can differ.
- **Tests**: the tests from `/api/tests` with a Run button each, plus Run all
  with Repeat, Seed and Compile first. Progress comes from `runner` stream
  events, so runs started by other clients (CLI, editor) show up too: the
  current stage, a `<progress>` of attempts, and a polite live region
  (attempt updates are throttled to one every 1.5 s). Results list each test
  with status, reliability, failure correlations and failed attempts with
  their error and an Expected / Received table per failed assertion.
  Running a single test passes its id as `filter`, which matches ids, names
  and files as substrings.

## Accessibility

Semantic landmarks (`header`, `nav`, `main`, `section`, `aside`), real
buttons, labelled inputs, data tables with `th scope`, and the WAI-ARIA tabs
pattern (Left / Right / Home / End move between tabs and select them). Busy
buttons use `aria-disabled` so they keep focus. Focus is always visible.
Light and dark themes follow `prefers-color-scheme`; motion is limited to
short color transitions and is disabled under `prefers-reduced-motion`.

## Layout and build

```
apps/desktop/
  src/index.ts        node entry: desktopStaticDir(), desktopUiBuilt()
  ui/*.ts             the dashboard, plain TypeScript (DOM lib, no node types)
  ui/tsconfig.json    compiles ui/ into public/js/
  public/             index.html, styles.css, favicon.svg, js/ (generated)
```

`pnpm build` (`tsc -b`) builds both projects; no bundler or framework is
involved and the browser loads the ES modules directly. `public/js/` is
generated and ignored by git. The daemon is given `desktopStaticDir()` as its
`staticDir`.
