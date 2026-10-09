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
| (not mapped yet) | `GetGameState`, `PushChanges(bVerseOnly)`, `GetClientLogEntries(pattern, maxResults)` |

## Results

| Step | Result |
|---|---|
| Connect, list toolsets | ✅ `uefn capabilities --adapter mcp` |
| Compile Verse (`runtime/verse/devtools.verse` + a POC device) | ✅ `Verse ✓` via BuildAll; the runtime compiled with no changes |
| Compile errors | ✅ BuildAll returns `{severity:"Error", code:3588, message, filePath, span:{startLine,...}}` (0-indexed); DevTools reported these as success before this run, now fixed |
| Place a Verse device in the level | ✅ `DeviceToolset/PlaceDevice` with the catalog `assetPath` from `ListDeviceAssets` |
| Session status | ✅ `Disconnected` read correctly (was mistaken for connected before this run, now fixed) |
| Launch session, start game, observe probe | ☐ not run yet (needs the Fortnite client) |

Also found: a folder named `DevTools` under `Content/` becomes a Verse module,
so a field named `DevTools` in a device beside it is ambiguous (error 3588).
