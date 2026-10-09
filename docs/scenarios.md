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
   (drag it in, or `DeviceToolset/PlaceDevice` over MCP).
2. Set `scenario.enabled: true` so player actions are routed to the device.
3. `uefn test <test-id>`. Regenerate whenever the test's steps change.

```yaml
scenario:
  enabled: true
  locations:            # named positions for teleport / enter / leave
    Sky: [0, 0, 3000]
  start_delay: 3s       # after the match starts, before the first step
  step_timeout: 60s     # how long the host waits for each step's report
```

`locations` falls back to `simulated.devices[].location`, so a test written
for the simulator can reuse its device positions.

## Step mapping

| YAML step | In the device | Reported events |
|---|---|---|
| `spawn_player: { id }` | binds the id to the next player in `GetPlayers()` order | `player.spawned` (with position), `scenario.step` |
| `teleport` / `enter` | `TeleportTo` the named location | `player.moved` (actual position), `scenario.step` |
| `leave` | `TeleportTo` 2000 units away from the area | `player.moved`, `scenario.step` |
| `damage: { amount }` | `Damage(amount)` | `player.state_changed` (health, shield), `scenario.step` |
| `eliminate` | `Damage` large enough to eliminate | `player.state_changed`, `scenario.step` |
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

- Verified live on UEFN 42.30: binding players, teleports and step
  reporting. `Damage` had no visible effect while the player was still in the
  island's sky-spawn state; land the player first (a `wait`, or teleport to
  the ground) and check the island allows damage, and assert the resulting
  health rather than only that a report arrived.
- Steps run in order on the device's own clock. The host checks each report
  in order and fails on a mismatch (`was 'damage_player' in game but the
  test sent 'teleport'`), a device-side failure, or a timeout.
- Because `wait_for` is not mirrored, put a `wait` before an action that
  must happen after an outcome.
- Teams in `spawn_player` are not enforced; players join by island settings.
- `eliminate.by` is not attributed (the damage has no instigator).
- The device uses its own emitter with `SeqStart := 1000000`, so its event
  ids never collide with the island's emitter.
- Only YAML tests can be turned into scenarios; TypeScript tests are code.
