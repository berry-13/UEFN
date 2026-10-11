# Live UEFN 42.30 session, 2026-10-09

Editor: Unreal Editor for Fortnite 6.0.0-58813929 (Fortnite Release-42.30),
fresh project `TestMCPClaude` (template POI_Greasy_Medium). DevTools CLI run
with Windows Node 24 against `http://localhost:8000/mcp` (WSL in NAT mode
cannot reach the editor's 127.0.0.1 listener).

## Turning the server on

- The MCP server needs the per-project experimental setting **UEFN MCP
  Toolsets** (`ValkyrieExperimentalToolsetSetting.bEnableToolsetsForProject`,
  under **Project > Project Settings > Experimental**). Without it the server
  may run but exposes no Valkyrie toolsets.
- `-ModelContextProtocolStartServer -ModelContextProtocolPort=N` on the
  command line was ignored when the editor was started directly.
- UEFN hides the editor console. Setting the console variable
  `ModelContextProtocol.ValkyrieManualLifeCycle=1` (`[ConsoleVariables]` in
  the user `Engine.ini`, which the editor deletes on exit) shows **Auto Start
  Server** under Editor Preferences > Plugins > Model Context Protocol; with
  it ticked the log shows
  `Starting MCP server on port 8000 at URL path '/mcp'`.

## Server shape

Meta-tool mode: `tools/list` returns only `list_toolsets`, `describe_toolset`
and `call_tool` (`toolset_name`, `tool_name` without the toolset prefix,
`arguments`). Results are wrapped as `{"returnValue": ...}`.

With the setting on, `list_toolsets` includes `ValkyrieToolset.SessionToolset`,
`ValkyrieToolset.VerseToolset`, `ValkyrieToolset.DeviceToolset`,
`ValkyrieToolset.EntityToolset` and `ValkyrieToolset.ValkyriePythonToolset`.

| DevTools operation | Live tool |
|---|---|
| compile | `ValkyrieToolset.VerseToolset/BuildAll` |
| start_session | `ValkyrieToolset.SessionToolset/StartSession` (optional `location`, Play From Here) |
| stop_session | `ValkyrieToolset.SessionToolset/StopSession` |
| session_state | `ValkyrieToolset.SessionToolset/GetSessionStatus` → `{"returnValue":"Disconnected"}` |
| start_game / end_game | `ValkyrieToolset.SessionToolset/StartGame` / `StopGame` |
| game_state | `ValkyrieToolset.SessionToolset/GetGameState` → `Unconnected` / `CanStart` / `Running` |
| (not mapped yet) | `PushChanges(bVerseOnly)`, `GetClientLogEntries(pattern, maxResults)` |

## Results

| Step | Result |
|---|---|
| Connect, list toolsets | ✅ `uefn capabilities --adapter mcp` |
| Compile Verse (`runtime/verse/devtools.verse` + a POC device) | ✅ `Verse ✓` via BuildAll; the runtime compiled with no changes |
| Compile errors | ✅ BuildAll returns `{severity:"Error", code:3588, message, filePath, span:{startLine,...}}` (0-indexed); DevTools reported these as success before this run, now fixed |
| Place a Verse device in the level | ✅ `DeviceToolset/PlaceDevice` with the catalog `assetPath` from `ListDeviceAssets` |
| Session status | ✅ `Disconnected` read correctly (was mistaken for connected before this run, now fixed) |
| Launch session | ✅ `StartSession` uploads, cooks and launches the Fortnite client; `uefn test` reached "Connected." |
| Runtime ready | ✅ the device's `Hello` arrived in the editor log and became `session.ready` |
| Observe a Verse value | ✅ `poc.counter` probes, one per second |
| Start game | ✅ UEFN auto-starts the match on launch and refuses `StartGame` while it runs ("The match is not in a startable state"); with `game_state` mapped, DevTools treats an already running match as started |
| Controlled action, value change | ✅ `poc-restart`: `StopGame` → `PostGameEnd`, `StartGame` → `InProgress`; the device restarted (new `Hello`, counter back to 1) |
| Assert, PASS/FAIL | ✅ `uefn test poc-001` PASS (counter reached 10, 28.3s); `uefn test poc-restart` PASS (28.5s) |

Wire lines as they appear in the editor log (the Verse log channel is
module-prefixed):

```
LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|H|0|0.1.0
LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|P|1|poc.counter|v:i=1
LogValkyrieBeacon: [3974] (ValkyrieBeaconClient_3) MinigameStateChanged: EFortMinigameState::InProgress
LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|P|2|poc.counter|v:i=2
LogValkyrieBeacon: [3974] (ValkyrieBeaconClient_3) MinigameStateChanged: EFortMinigameState::PostGameEnd
```

Fixed along the way, each found only against the live editor: compile errors
read as a clean build, `Disconnected` read as connected, a Windows exit crash
(libuv assertion), `StartGame` failing on an auto-started match, and
`game.start()` waiting for an event that had already happened. The files used
are in [`examples/uefn-live`](../../examples/uefn-live).

Also found: a folder named `DevTools` under `Content/` becomes a Verse module,
so a field named `DevTools` in a device beside it is ambiguous (error 3588).

## Scenario device (player actions), 2026-10-10

`uefn scenario scenario-live` generated a device from a YAML test (spawn,
damage 25, wait 1s, teleport to `Sky`); it compiled and was placed over MCP,
and `uefn test scenario-live` passed (100s). From the editor log:

```
[UEFN-DEVTOOLS]|1|E|1000002|player.spawned|player=player1|position:v=0.000000,0.000000,20995.640416
[UEFN-DEVTOOLS]|1|E|1000004|player.state_changed|player=player1|health:f=100.000000|shield:f=0.000000
[UEFN-DEVTOOLS]|1|E|1000006|player.moved|player=player1|position:v=0.000000,0.000000,3000.000000
```

| Action | Result |
|---|---|
| Bind player, report position | ✅ |
| Teleport | ✅ the player moved from the sky spawn (z ≈ 21000) to exactly (0, 0, 3000) |
| Damage | ✅ in `damage-live` (below); in this first run `Damage(25.0)` had no effect because the player was still in the sky-spawn state |
| Step ordering, reports, host confirmation | ✅ |

Two launches before this one stalled in UEFN's own pipeline (Session
Inspector: Versioning failed after 31 minutes, "Unable to Play: Failed to
resolve validation session"); DevTools now reports that case explicitly
instead of a bare MCP timeout.

### Damage on a grounded player

`uefn test damage-live` (teleport onto the ground at a point traced with
`EditorAppToolset/ScreenCoordsToWorld`, wait 5s, `damage 25`) passed with
`health = 75` asserted exactly:

```
[UEFN-DEVTOOLS]|1|E|1000004|player.moved|player=player1|position:v=757.000000,351.000000,484.000000
[UEFN-DEVTOOLS]|1|E|1000006|player.state_changed|player=player1|health:f=75.000000|shield:f=0.000000
```

### Eliminate

`uefn test eliminate-live` (same setup, then `eliminate`) passed with
`alive: false` asserted; the device saw health 0 and reported the
elimination:

```
[UEFN-DEVTOOLS]|1|E|1000006|player.state_changed|player=player1|health:f=0.000000|shield:f=0.000000
[UEFN-DEVTOOLS]|1|E|1000007|player.eliminated|player=player1
```

### Eliminate, respawn, act again (2026-10-11)

`eliminate-live` was extended past the elimination: wait for the island to
respawn the player, teleport to the ground again, then `damage 25`. It
passed with the player alive afterwards. A diagnostic build of the device
read the character from the captured player at each step:

```
after-eliminate     health 0    active 0  position [757, 351, 461]
before-spawn-step   health 100  active 1  position [0, 0, 19192]
after-teleport      health 100  active 1  position [757, 351, 484]
before-damage       health 90   active 1  position [757, 351, 461]
```

So `Player.GetFortCharacter[]` returns the respawned, active character, and
steps after a respawn act on it. The island respawns players skydiving
(Z about 19,000); a teleport during that fall keeps the fall speed, so the
landing costs some health (10 in this run, all of it in another), and the
test does not assert an exact health value after a respawn.

The same runs showed the host and device racing on the implicit spawn: the
device's `player.spawned` can arrive before the host's teleport, so the
host no longer sees the player down and skips its own `spawn_player`. The
device marks that step `arg=implicit` and the host passes over it; both
orders passed live.

The same session also showed that `describe_toolset` names tools
`<toolset>.<tool>` (`ValkyrieToolset.VerseToolset.BuildAll`), which the
connect-time tool check now accepts.

### Reused sessions, launch timing and lethal damage (2026-10-11)

- **Reused session.** With a play session started beforehand (match
  `Running`), `uefn test eliminate-live` attached to it, restarted the match
  (StopGame, then StartGame) and the scenario device ran again: PASS.
- **Launch timing.** With a Fortnite client already running, the match
  started and the runtime logged its hello about 15 s after StartSession was
  dispatched, before the call returned. The log was then tailed from the
  end, so the hello was missed and the run timed out waiting for
  `session.ready`. The log is now read from its size before the launch;
  the same run then passed.
- **Session boundary.** Each play session launch logs
  `LogValkyrieActivityTracker: Session -> Start Activity: Matchmaking`. A
  backfill on a reused session no longer looks past it, so a hello from an
  earlier session is not replayed.
- **Lethal damage.** After a respawn, the landing alone can eliminate the
  player; the following `damage` step then reads health 0 and now reports
  `player.eliminated`. The live test asserts only outcomes that always hold.
