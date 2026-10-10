# VS Code extension

`apps/vscode` (package `uefn-devtools-vscode`, display name "UEFN DevTools")
brings tests, Verse diagnostics and live runtime data into VS Code using
native UI only: the Test Explorer, the Problems panel, tree views, the status
bar, quick inputs and notifications. There are no webviews.

The extension never imports workspace packages at runtime. It is a CommonJS
build (`dist/extension.js`) that talks to:

- the `uefn` CLI, spawned with `--json` (`list`, `test`, `compile`,
  `daemon start --detach`, `daemon stop`, `ui`);
- the daemon over HTTP (`fetch`) and Server-Sent Events, when a live daemon
  serves the project (see [daemon.md](daemon.md)).

The wire shapes it reads are duplicated in `apps/vscode/src/types.ts`; keep
them in sync with `packages/protocol` and `packages/daemon/src/api.ts`.

## Requirements

- Node 22.18 or newer on `PATH`. The CLI runs TypeScript tests through
  Node's type stripping, so it cannot use VS Code's bundled runtime.
- The CLI, found in this order (`uefnDevtools.cliPath` overrides all of it):
  1. `node_modules/.bin/uefn` in the project root or any ancestor;
  2. `node_modules/@uefn-devtools/cli/dist/main.js` (run with `node`) in the
     same directories, for pnpm installs where the bin link was skipped
     because the CLI was not built yet;
  3. `uefn` on `PATH`.

## Project root

The project is the directory holding `uefn-devtools.config.yaml`. With
several, the shallowest wins; set `uefnDevtools.projectRoot` (relative to the
first workspace folder) to pick one. Without a config file the first
workspace folder is used.

## Features

### Test Explorer

- Discovery runs `uefn list --json` on activation, on the Test Explorer
  refresh button, on "UEFN: Refresh Tests", and (debounced) when any
  `*.test.ts`, `*.test.yaml` or `*.test.yml` under the project changes.
- Tests are grouped by file. Each test links to its definition line (the YAML
  `name:` key or the `test("...")` call). Files that fail to load show the
  error on the file item.
- Run profiles:
  - **Run** (default): `uefn test <id> --json` per selected test, or one
    unfiltered `uefn test --json` when every test is selected.
  - **Run with repeat...**: asks for N (1 to 1000) and adds `--repeat N`. The
    result shows reliability (`Reliability 89% (89 of 100 passed, 11 failed)`),
    the failure correlations, and the first failing iteration with its seed.
- When a live daemon serves the project (`.devtools/daemon.json` exists and
  its pid is alive), runs go through `POST /api/tests/run` instead, sharing
  the daemon's session.
- Results: `passed`, `failed` (assertion failures) or `errored` (the run or
  the attempt broke) with the attempt duration. Failed assertions become diff
  messages (expected against received). Every message names the failed stage
  (for example `failed in stage ASSERTING`). Tests a run-level failure never
  reached (VALIDATING, BUILDING, session start) are errored with that error.
- Cancelling kills the CLI process. A daemon run cannot be cancelled from the
  client; the request is dropped and the daemon finishes in the background.
- CLI progress (stderr) streams into the test run output.

The CLI filter is a substring match on id, name and file, so running one test
can also run others whose id contains it; only the requested results are
reported.

### Verse diagnostics

"UEFN: Compile Verse" runs `uefn compile --json` (or `POST /api/compile` with
a live daemon) and fills the `uefn-verse` diagnostic collection. Relative
diagnostic paths resolve against the project root; diagnostics without a file
go to the "UEFN DevTools" output channel. With `uefnDevtools.compileOnSave`,
saving a `.verse` file compiles in the background.

### Live Events and Game State

The "UEFN DevTools" activity bar container holds two tree views:

- **Live Events**: the latest 500 `runtime` events from
  `GET /api/stream?token=`, newest first. Expanding an event loads its causal
  tree from `GET /api/events/:id/trace`; the selected event is marked
  "(selected)". The stream reconnects (resuming from the last index) while the
  daemon's pid is alive. "Clear Events" empties the list.
- **Game State**: phase and round, then teams, devices and players from
  `GET /api/state`, refreshed on `session` messages and (throttled to once a
  second) on runtime events, or with the refresh button.

Both show a "Start Daemon" welcome view when no daemon is running. The
extension watches `.devtools/daemon.json`, so starting or stopping the daemon
from a terminal connects or disconnects the views without polling.

### Status bar

Shows "UEFN: no daemon" or "UEFN: session connected" (or the current session
status). With no daemon, activating it runs `uefn daemon start --detach --ui`, retrying without `--ui` (and warning that the dashboard is unavailable) if that fails;
with one, it runs `uefn ui` to open the dashboard. If the CLI has no `ui`
command (or it fails early), a warning explains why instead of failing
silently. The item has an accessible label describing the state and the
action.

### YAML test schema

`schemas/yaml-test.schema.json` (JSON Schema draft 7) is generated from
`YamlTestSchema` in `packages/test/src/yaml.ts` with zod's `z.toJSONSchema`
(input side, so defaulted fields are optional). The extension contributes it
through `contributes.yamlValidation` for `*.test.yaml` and `*.test.yml`, so
the Red Hat YAML extension validates and completes test files. One deliberate
difference: the schema rejects unknown top-level keys, which the runner
silently drops, so a typo such as `step:` is flagged.

Regenerate after changing `YamlTestSchema`:

```
pnpm build
pnpm --filter uefn-devtools-vscode gen:schema
```

`apps/vscode/test/schema.test.ts` fails when the committed file is out of
date.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `uefnDevtools.cliPath` | `""` | CLI path or command; `.js` files run with `node`; relative paths resolve against the project root |
| `uefnDevtools.adapter` | `""` | `simulated` or `mcp`, passed as `--adapter`; empty uses the config file |
| `uefnDevtools.compileOnSave` | `false` | Compile Verse when a `.verse` file is saved |
| `uefnDevtools.projectRoot` | `""` | Project directory relative to the first workspace folder |

## Commands

All are in the "UEFN" category: Compile Verse, Refresh Tests, Start Daemon,
Stop Daemon (shown while a daemon runs), Open Dashboard, Refresh Game State,
Clear Events, Show Output.

## Development

```
pnpm build                     # builds apps/vscode/dist with the rest
pnpm test                      # includes apps/vscode/test/*.test.ts
```

Pure logic lives in modules that do not import `vscode` and is unit tested
against the built `dist/*.js`: `sse.ts` (SSE parser), `cli.ts` (CLI
resolution and spawning), `mapping.ts` (RunSummary to test results, compile
diagnostics, run planning), `daemon.ts` (daemon discovery and HTTP client).
The `vscode`-facing glue is `extension.ts`, `project.ts`, `testing.ts`,
`compile.ts` and `views.ts`.

To try it after `pnpm build`, run
`code --extensionDevelopmentPath="$PWD/apps/vscode" examples/capture-point`,
or package it from a copy of the folder (keep the `.vsix` out of git):

```
npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
```

`activate` returns `{ root, discover() }`, which an extension-host smoke test
(through `@vscode/test-electron`) can use to check discovery.
