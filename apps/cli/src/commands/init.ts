import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE } from "@uefn-devtools/core";
import type { Command } from "../shared.ts";
import { initGithubWorkflow } from "./github-workflow.ts";

const STARTER_CONFIG = `# UEFN DevTools configuration
project:
  name: MyIsland

paths:
  verse: ./Verse
  tests: ./Tests

# simulated: built-in reference simulator (no UEFN needed)
# mcp:       drive UEFN through its MCP server (see docs/capabilities.md)
adapter: simulated

simulated:
  devices:
    - id: CapturePointA
      capture_time_ms: 5000
      score: 50

mcp:
  # UEFN 42.30+: enable Project > Project Settings > Experimental >
  # "UEFN MCP Toolsets" (docs/evidence/uefn-42.30-live.md).
  # url: http://localhost:8000/mcp
  timeout_ms: 120000
  # Live 42.30 tool names, reached through call_tool (uncomment to map them):
  # tools:
  #   compile: ValkyrieToolset.VerseToolset/BuildAll
  #   start_session: ValkyrieToolset.SessionToolset/StartSession
  #   stop_session: ValkyrieToolset.SessionToolset/StopSession
  #   session_state: ValkyrieToolset.SessionToolset/GetSessionStatus
  #   start_game: ValkyrieToolset.SessionToolset/StartGame
  #   end_game: ValkyrieToolset.SessionToolset/StopGame
  #   game_state: ValkyrieToolset.SessionToolset/GetGameState

runtime:
  # log_path: C:/Users/<you>/AppData/Local/UnrealEditorFortnite/Saved/Logs/UnrealEditorFortnite.log
  ready_timeout: 120s

tests:
  timeout: 30s
  retries: 0

mcp_server:
  mode: development
`;

export const init: Command = {
  name: "init",
  usage: "init [--github]",
  summary: `Write a starter ${CONFIG_FILE} (--github: a CI workflow instead)`,
  options: { github: { type: "boolean" } },
  optionHelp: ["--github               Write .github/workflows/uefn-devtools.yml"],
  async run(values) {
    if (values.github) return initGithubWorkflow(process.cwd());
    const path = join(process.cwd(), CONFIG_FILE);
    if (await stat(path).then(() => true, () => false)) {
      console.error(`${CONFIG_FILE} already exists`);
      return 2;
    }
    await writeFile(path, STARTER_CONFIG);
    console.log(`Wrote ${CONFIG_FILE}`);
    return 0;
  },
};
