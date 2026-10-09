# Writing tests

Test files live in `paths.tests` (default `./Tests`) and match `*.test.ts`
or `*.test.yaml`.

## TypeScript

```ts
import { expect, test } from "@uefn-devtools/test";

test("capturing A awards 50 points", async ({ game }) => {
  const player = game.player("player1", { team: 1 });

  await game.start();
  await player.enter("CapturePointA");

  await expect(game.device("CapturePointA")).toHaveState("Captured");
  await expect(game.team(1)).toHaveScore(50);
});
```

Test files run through Node's built-in type stripping (Node ≥ 22.18), so
they must use erasable TypeScript only: no `enum`, no `namespace`, no
parameter properties.

### Fixture: `game`

| API | Notes |
|---|---|
| `game.start()` / `game.end()` | waits for `game.started` |
| `game.player(id, { team })` | handle; spawns on first action, or call `.spawn()` |
| `player.enter(area)` | waits until the runtime reports the entry |
| `player.teleport(loc)`, `.leave(area)`, `.eliminate({ by })`, `.damage(n)` | |
| `player.health`, `.shield`, `.alive`, `.teamId`, `.position`, `.state` | live reads |
| `game.device(id)` → `.enable()`, `.disable()`, `.current`, `.owner` | |
| `game.team(n).score` | |
| `game.probe(id).value` | instrumented runtime values |
| `game.events.list(type?, match?)`, `.count(...)` | events since the test started |
| `game.event(type, match?)` | future event, for `toOccurWithin` |
| `game.wait("2s")`, `game.waitForEvent(type, match?, { timeout })` | |

### Assertions

Handle assertions retry until they pass or `timeout` elapses (default
`tests.expect_timeout`). Once a condition matches, it must keep holding for
`settle` (default `tests.expect_settle`).

| Target | Matchers |
|---|---|
| device | `toHaveState`, `toHaveOwner`, `toBeEnabled`, `toBeDisabled`, `toHaveTriggerCount` |
| team / player | `toHaveScore` |
| player | `toHaveHealth`, `toHaveShield`, `toBeAlive`, `toBeEliminated`, `toBeOnTeam`, `toBeInArea` |
| probe | `toHaveValue` |
| `game.events` | `toHaveOccurred(type, match?, { times? })`; `times: 0` asserts absence |
| `game.event(...)` | `toOccurWithin(ms)` |
| `game` | `toMatchSnapshot(name?, { include?, ignore? })`, see Snapshots |
| any value | `toBe`, `toEqual`, `toMatchObject`, `toBeGreaterThan`, `toBeLessThan`, `toBeTruthy` |

A plain value is checked once. Pass a function, such as
`expect(() => player.health).toBe(100)`, to make the check retry.

Custom matchers (spec §66):

```ts
expect.extend({
  toOwnCapturePoint(team, point) {
    const owner = /* read state */;
    return { pass: owner === team.id, expected: team.id, received: owner };
  },
});
```

A test that makes no assertions fails.

## YAML

```yaml
name: Capture Point A
setup:
  - start_game
  - spawn_player: { id: player1, team: 1 }
steps:
  - teleport: { player: player1, location: CapturePointA }
  - wait_for: { event: CaptureCompleted, timeout: 10s }
assert:
  - device: { id: CapturePointA, state: Captured, owner: 1 }
  - team: { id: 1, score: 50 }
  - event: { type: ScoreChanged, times: 1 }
```

Steps: `start_game`, `end_game`, `spawn_player`, `teleport`, `enter`,
`leave`, `eliminate`, `damage`, `enable_device`, `disable_device`, `wait`,
`wait_for`.

Assertions: `device`, `team`, `player`, `event`, `probe`, `snapshot`.

```yaml
assert:
  - snapshot: end-state
  - snapshot:
      name: scores
      include: [teams, devices]
      ignore: [devices.*.progress]
```

The schema rejects unknown keys during VALIDATING, before any session
starts. A file can hold several tests as separate YAML documents (`---`).

## Snapshots

`expect(game).toMatchSnapshot(name?)` (YAML: `- snapshot: <name>`) compares the
whole derived GameState with a stored copy, Playwright and Jest style.

The snapshot is the normalized state: `phase`, `round`, `winner`, devices,
teams, players and probes, with keys sorted and area lists ordered.
Volatile fields are dropped: `startedAt`, `endedAt`, and player positions
unless you add `positions` to `include`. `include` picks sections
(`devices`, `teams`, `players`, `probes`, `positions`); `ignore` removes
dotted paths, where `*` matches any key (`players.*.health`).

Snapshots live next to the test in `__snapshots__/<test file>.snap.json`,
keyed by test id and snapshot name. Commit them. Like other state
assertions, the check waits for the state to hold for the settle window, so
the result does not depend on when the last event landed.

| Situation | Result |
|---|---|
| No stored snapshot | written, assertion passes (`snapshot 'x' written`) |
| Stored snapshot matches | passes |
| Mismatch | fails with `path: expected X, received Y` lines |
| `uefn test --update-snapshots` | stored snapshots are overwritten |
| `CI` set and no stored snapshot | fails instead of writing, like `jest --ci` |

Unnamed calls are numbered per test (`snapshot-1`, `snapshot-2`). Engine
independent helpers are exported from `@uefn-devtools/test`:
`snapshotState(state, options)`, `diffSnapshots(a, b)` and
`formatSnapshotDiff(diffs)`.

## Recording

`uefn record` turns an observed session into a YAML test; see `recorder.md`.

## Running

```
uefn test                     # all tests
uefn test capture             # tests whose id, name or file contains "capture"
uefn test capture --repeat 100 --seed 1
uefn test --watch
uefn test --update-snapshots   # accept new or changed state snapshots
uefn test --json              # RunSummary on stdout
```

Exit codes: `0` passed · `1` a test failed · `2` the run could not complete
(validation, compile, session, or usage).

With `--repeat`, the report shows reliability, plus any event type whose
count separates every failing run from every passing one:

```
Capture Point A

PASS 89
FAIL 11

Reliability 89%

Failure correlation:
  score.changed occurred 2× in every failing run vs 1× in passing runs
```

Inspect one failure's causal chain from its artifacts:

```
uefn trace sim_27 --file .devtools/results/<date>/<run>/capture-point-a-7/events.jsonl
```
