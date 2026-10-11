# Live UEFN example (POC-001)

The files that ran POC-001 against a live UEFN 42.30 session on 2026-10-09
([evidence](../../docs/evidence/uefn-42.30-live.md)). Copy them into a UEFN
project folder (next to its `.uefnproject`):

| File | Goes to |
|---|---|
| `uefn-devtools.config.yaml` | project root; replace `<you>` in `runtime.log_path` |
| `Content/DevTools/devtools_poc_device.verse` | `Content/DevTools/` |
| `runtime/verse/devtools.verse` (from this repo) | `Content/DevTools/` |
| `DevToolsTests/*.test.yaml` | `DevToolsTests/` |

Then:

1. Enable **Project > Project Settings > Experimental > UEFN MCP Toolsets**
   and make sure the MCP server listens on port 8000
   (see [capabilities](../../docs/capabilities.md#how-to-fill-this-in)).
2. `uefn compile`, then place the `DevTools-devtools_poc_device` device in the
   level (drag it in, or `DeviceToolset/PlaceDevice` over MCP).
3. `uefn test poc-001` and `uefn test poc-restart`. Each launches a play
   session, so the Fortnite client opens.
4. Player actions: `uefn scenario damage-live`, compile, place the generated
   device, then `uefn test damage-live` (needs `scenario.enabled: true` and a
   `Ground` location on solid ground in your map; see
   [scenarios](../../docs/scenarios.md)).

On Windows with WSL in NAT mode, run the CLI with Windows Node: WSL cannot
reach the editor's `127.0.0.1` listener.
