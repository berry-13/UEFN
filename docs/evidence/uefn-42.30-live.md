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
| Damage | ☐ `Damage(25.0)` ran but health stayed 100: the player was still in the sky-spawn state, or the island disables damage. Not verified |
| Step ordering, reports, host confirmation | ✅ |

Two launches before this one stalled in UEFN's own pipeline (Session
Inspector: Versioning failed after 31 minutes, "Unable to Play: Failed to
resolve validation session"); DevTools now reports that case explicitly
instead of a bare MCP timeout.
