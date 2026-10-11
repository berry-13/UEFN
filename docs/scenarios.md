# Scenario devices: player actions on real UEFN

UEFN's MCP tools can compile, launch sessions and start or stop a match, but
none of them acts on players inside a running match. Steps such as
`teleport`, `damage` or `eliminate` therefore run from a **scenario device**:
a Verse `creative_device` that DevTools generates from a YAML test. Inside
the match the device performs the steps with `fort_character` APIs and
reports each one through the DevTools emitter; on the host, the test waits
for those reports instead of sending commands. This is option 2 of
[the command gap](capabilities.md#the-command-gap).

```
uefn scenario <test-id> [--out <dir>]
```

writes `devtools_scenario_<test-id>.verse` into `scenario.output`
(default `./Content/DevTools/Generated`). Then:

1. Compile (`uefn compile`) and place one device of that class in the level
   (drag it in, or `DeviceToolset/PlaceDevice` over MCP). Place exactly one
   scenario device per test run: remove the devices of other tests.
2. Set `scenario.enabled: true` so player actions are routed to the device.
3. `uefn test <test-id>`. Regenerate whenever the test's steps change.

```yaml
scenario:
  enabled: true
  locations:            # named positions for teleport / enter / leave
    Sky: [0, 0, 3000]
    Zone.outside: [-2000, 0, 0]   # optional: where `leave: { area: Zone }` goes
  start_delay: 3s       # after the match starts, before the first step
  step_timeout: 60s     # how long the host waits for each step's report
```

`locations` falls back to `simulated.devices[].location`, so a test written
for the simulator can reuse its device positions.

`uefn scenario` refuses to overwrite a generated file that belongs to a
different test. Ids such as `foo-bar` and `foo_bar` map to the same class
name; give one of them a distinct id, or use `--out`.

The test must `start_game` before its first player action (normally in
`setup`), and may not start or end the match after it. The device runs when
the match begins and replays its whole plan on every match start, so a
match it was not started by the test would report before the test began
(and the test's observed state would miss those events), and a restart
between actions would replay the earlier ones. Both are refused at
generation time. `start_delay` only spaces the first step from the match
start; it is not a synchronisation point with the host.

## Step mapping

| YAML step | In the device | Reported events |
|---|---|---|
| `spawn_player: { id }` | binds the id to the next player in `GetPlayers()` order | `player.spawned` (with position), `scenario.step` |
| `teleport` / `enter` | `TeleportTo` the named location; first a spawn step if the player has not spawned yet or was eliminated, as the host does | `player.moved` (actual position), `scenario.step` |
| `leave` | `TeleportTo` `<area>.outside` if configured, else 2000 units along +X from the area's position (not checked to be outside the area) | `player.moved`, `scenario.step` |
| `damage: { amount }` | `Damage(amount)` | `player.state_changed` (health, shield), `player.eliminated` when health reads 0, `scenario.step` |
| `eliminate` | `Damage` large enough to eliminate; the step fails if health stays above 0 (an invulnerable or sky-spawning player) | `player.state_changed`, `player.eliminated`, `scenario.step` |
| `wait` | `Sleep` | none |
| `start_game` / `end_game` | nothing (the host does it over MCP) | |
| `wait_for` | not mirrored: the device cannot see DevTools events | |
| `enable_device` / `disable_device` | refused at generation time | |

The device reports only what it observes (positions after the teleport,
health after the damage). Gameplay outcomes such as `player.entered_area` or
`capture.completed` must come from the island's own instrumentation, so a
test against real UEFN proves the gameplay reacted, not just that the
player moved.

## Rules and limits

- Verified live on UEFN 42.30: binding players, teleports, damage (health
  100 → 75 asserted) and step reporting. `Damage` has no effect while the
  player is still in the island's sky-spawn state: land the player first
  (teleport to the ground, then `wait`), and assert the resulting health
  rather than only that a report arrived. `eliminate` verified live too
  (health 0, `alive: false`).
- Steps run in order on the device's own clock. The host checks each report
  in order and fails on a mismatch (`was 'damage_player' in game but the
  test sent 'teleport'`), a device-side failure, or a timeout.
- Every scenario event carries the test id (`scenario`); `scenario.started`
  also carries a fingerprint of the plan, its waits, the start delay and the
  resolved teleport positions (`plan`), and each `scenario.step`
  the argument it was generated from (`arg`: location, area, damage amount,
  eliminator). The host locks onto the first scenario that starts in a match
  and ignores the others' reports, but fails the next step if a second
  scenario, or a second build of the same one, starts in that match. A step
  whose argument differs from what the test sends fails as a stale device:
  regenerate and recompile. With `scenario.enabled`, the runner also tells
  the host which device each YAML test generates, so a single placed device
  that is stale or belongs to another test is refused at its first step.
  `game.ended` releases the lock and drops the match's unconsumed reports; a
  step still waiting fails then.
- When `uefn test` attaches to a session whose match is already running,
  the device ran before the host attached, so the first `start_game`
  restarts the match (StopGame, then StartGame) to run the device again.
- A player is captured at the player's first step and reused, so players
  joining or leaving later do not shift who a step acts on. Each step reads
  the player's current character, so after an `eliminate` the next
  `teleport` / `enter` (which adds a spawn step) acts on the respawned
  character (verified live). The island must respawn the player first, so
  put a `wait` before it; a step whose player has no character fails. That
  spawn step is reported with `arg: implicit`, and the host passes over it
  when its own state already shows the player respawned. A player respawned
  skydiving keeps its fall speed through a teleport and takes landing
  damage, so do not assert an exact health after a respawn.
- Because `wait_for` is not mirrored, put a `wait` before an action that
  must happen after an outcome.
- Teams in `spawn_player` are not enforced; players join by island settings.
- `eliminate.by` is not attributed (the damage has no instigator).
- The device uses its own emitter with `SeqStart := 1000000`, so its event
  ids never collide with the island's emitter. Its `Hello` carries that
  offset too (`rt_1000000`), so it adds a second `session.ready` rather than
  replacing the island's.
- Only YAML tests can be turned into scenarios; TypeScript tests are code.
