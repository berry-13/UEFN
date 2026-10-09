# Recording a session into a test

Some things cannot be driven from outside UEFN (see "The command gap" in
`capabilities.md`, option 3, manual plus recorder). The recorder covers that
case: play the game yourself while DevTools observes, and the observed
session becomes a regression test.

```
uefn record capture-demo                 # observe for 30s (or until Ctrl+C)
uefn record capture-demo --duration 2m
uefn record capture-demo --script steps.yaml     # drive the simulator, no human
uefn record --from .devtools/recordings/capture-demo.uefnrec.json
```

| Option | Meaning |
|---|---|
| `[name]` | Recording and test name (default `recording-<timestamp>`) |
| `--duration <d>` | Session-clock length, default `30s`. Ctrl+C stops early |
| `--out <path>` | Generated test file, default `<paths.tests>/<name>.test.yaml` |
| `--script <file>` | YAML steps to run against the simulator while recording |
| `--from <file>` | Skip recording; regenerate a test from a saved recording |
| `--force` | Overwrite an existing test file (refused otherwise) |

`record` starts or reuses a session, waits for the runtime, then records.
With `--script` it resets and seeds the world first (as the test runner
does) and records until the last step finishes. The script is a list of the
same steps YAML tests use, or a test-shaped document whose `setup` and
`steps` run in order:

```yaml
- start_game
- spawn_player: { id: player1, team: 1 }
- enter: { player: player1, area: CapturePointA }
- wait: 6s
```

## The recording file

`.devtools/recordings/<name>.uefnrec.json` holds metadata (session id, git
commit and dirty state, adapter, session-clock start and end, wall-clock
start) and every event observed between start and stop. It is plain JSON,
so it can be diffed, attached to a bug report, or turned into a test later
with `--from`. `.devtools/` is git-ignored; commit the generated test, not
the recording.

## Generated test

| Observed | Becomes |
|---|---|
| `game.started` / `game.ended` | `start_game` / `end_game` |
| `player.spawned` | `spawn_player` (with team) |
| `player.entered_area` | `enter` |
| `player.exited_area` | `leave`, unless a teleport or elimination caused it |
| `player.state_changed` with lost health or shield | `damage` |
| `player.eliminated` | `eliminate` (with `by`) |
| `device.state_changed` flipping `enabled` | `enable_device` / `disable_device` |
| gaps of at least 500ms between actions | `wait`, rounded to 500ms |
| `capture.completed` | `wait_for` (matching device and team) instead of a fixed wait |

Leading `start_game` and `spawn_player` steps go in `setup`. Assertions come
from the state derived by replaying the recording:

- every device's final `state`, `owner`, and `enabled` when disabled
- every team's final score
- `event` assertions with an exact `times` for `capture.completed` and
  `score.changed`

The output is validated against the YAML test schema and opens with a
comment naming the recording. Treat it as a first draft: delete assertions
you do not care about and tighten the ones you do.

Limits worth knowing:

- Waits come from timestamp gaps, so a test replays timing approximately.
  The runner's assertions poll and settle, which absorbs small drift.
- The end state is whatever was true when you stopped. `record` waits two
  settle windows first so a pending tick lands, but stopping mid-capture
  records a mid-capture state.
- `wait_for` searches the whole test, so a second capture of the same point
  can be satisfied by the first. Add a `match` or adjust by hand.
- Only actions the runtime reports as events are recorded. A human's raw
  movement is not replayable unless the runtime emits `player.entered_area`.

## API

```ts
import { Recorder, loadRecording, saveRecording, recordingPath } from "@uefn-devtools/core";
import { generateYamlTest } from "@uefn-devtools/test";

const recorder = new Recorder(engine, { name: "demo" });
recorder.start();
// ... play ...
const recording = recorder.stop();
await saveRecording(recording, recordingPath(engine.root, "demo"));
const { yaml, test } = generateYamlTest(recording, { name: "Demo" });
```

`generateYamlTest` options: `name`, `id`, `waits` (default true), `roundTo`,
`minWait`, `waitFor`, `assertEvents`, `players` (also assert each player's
alive flag and team).
