# Recorder

The recorder turns a played session into something reproducible (spec §21–23).

```
uefn record                  # play, Ctrl+C → recording + generated test
uefn record --bug            # play the bug, Ctrl+C → anomaly report
uefn recordings              # list saved recordings
uefn generate-test rec_…     # (re)generate a test from a recording
```

`uefn record` uses the running daemon if there is one, so the dashboard shows
the recording live. Otherwise it records a private session. The dashboard's
**Record** view does the same with buttons, and with the simulated adapter
it also offers **simulator controls** (start game, spawn, enter area, leave,
damage, eliminate), so you can "play" without Fortnite.

Agents use `uefn_start_recording`, `uefn_stop_recording`,
`uefn_list_recordings` and `uefn_generate_test_from_recording`.

## Why it matters for real UEFN

DevTools can **observe** a real session (the Verse runtime writes to the
output log) but cannot yet **drive** one (see
[the command gap](capabilities.md#the-command-gap)). Recording is the way to
get real tests anyway. You play in UEFN; DevTools records what the runtime
reports; the generated test captures what should happen. Running it
unattended still needs a way to perform the steps, but the observations and
assertions work today.

## From recording to test

A recording is a window of `RuntimeEvent`s saved to
`.devtools/recordings/<id>.json`. It is self-contained (events, git info,
adapter), so you can attach it to an issue or an agent prompt.

Generation separates **actions** from **observed side effects** (§22):

| Recorded event | Becomes |
|---|---|
| `game.started` / `game.ended` | `start_game` / `end_game` |
| `player.spawned` | `spawn_player {id, team}` |
| `player.entered_area` | `enter {player, area}` |
| `player.exited_area` | `leave`, unless caused by a teleport or elimination in the same action |
| `player.eliminated` | `eliminate {player, by}`, unless caused by recorded lethal damage |
| `player.state_changed` with lower health | `damage {player, amount}` |
| `player.moved` not into an area | `teleport {player, location}` |
| captures, score changes, custom events | `wait_for` synchronisation points, never steps |
| final device state, team score gains, eliminations, probe values | assertions |

Rules that keep generated tests from being brittle:

- **Only the final state is asserted.** Intermediate states such as
  `Capturing` are not.
- **Only what changed.** A device that was only reported at game start is not
  asserted.
- **Scores are gains**, summed from `delta`s. A recording that starts
  mid-game still produces a valid test from a fresh game.
- **`wait_for` uses `count`**, so "the second capture of A" is not satisfied
  by the first.
- **Waits are kept only while time matters**, i.e. a player is in an area and
  a capture can progress. Think time between actions is dropped.
- **"Same action" means adjacent in the event log**, not close in time. The
  simulator compresses time and real logs batch lines, so timestamps cannot
  tell you causality.
- `--counts` adds exact milestone counts (stricter, more brittle).
- A recording with nothing to assert writes no test.

## Bug recordings

`--bug` (or kind `bug`) adds a deterministic anomaly report:

| Rule | Finds |
|---|---|
| `duplicate-effect` | one cause producing the same effect twice, e.g. `score.changed fired 2× from the same capture.completed` |
| `rapid-repeat` | the same event on the same entity within 50 ms |
| `runtime-log` | errors and warnings from the runtime log, including malformed DevTools lines |

Each finding lists event ids and trace ids for `uefn trace` / `uefn_trace_event`.

A test generated from a bug recording asserts the values that were
**observed**, buggy ones included, and says so in a header comment. Change
those values to the expected behaviour and you have a regression test that
fails until the bug is fixed.
