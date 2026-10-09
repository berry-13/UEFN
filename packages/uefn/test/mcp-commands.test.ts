import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpAdapterConfig } from "@uefn-devtools/protocol";
import { McpUefnAdapter } from "@uefn-devtools/uefn";


/** A stdio MCP server with UEFN-like session tools; each call is appended to a calls file. */
async function fakeServer(dir: string): Promise<{ script: string; calls: string }> {
  const calls = join(dir, "calls.txt");
  const script = join(dir, "server.mjs");
  const mcp = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const stdio = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  await writeFile(
    script,
    `import { McpServer } from ${JSON.stringify(mcp)};
import { StdioServerTransport } from ${JSON.stringify(stdio)};
import { appendFileSync } from "node:fs";
const server = new McpServer({ name: "fake-uefn", version: "0" });
for (const name of ["StartSession", "StartGame", "StopGame"]) {
  server.registerTool(name, { description: name }, async () => {
    appendFileSync(${JSON.stringify(calls)}, name + "\\n");
    return { content: [{ type: "text", text: "Completed" }] };
  });
}
await server.connect(new StdioServerTransport());
`,
  );
  await writeFile(calls, "");
  return { script, calls };
}

test("start_game / end_game go through mapped MCP tools; player actions stay unsupported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-mcp-"));
  const { script, calls } = await fakeServer(dir);
  const log = join(dir, "UnrealEditorFortnite.log");
  await writeFile(log, "");
  const adapter = new McpUefnAdapter({
    mcp: McpAdapterConfig.parse({
      command: process.execPath,
      args: [script],
      tools: { start_session: "StartSession", start_game: "StartGame", end_game: "StopGame" },
      timeout_ms: 20_000,
    }),
    logPath: log,
  });
  try {
    await adapter.connect();
    await adapter.startSession({ headed: true });
    const transport = adapter.transport();
    assert.deepEqual([...transport.supportedCommands()].sort(), ["end_game", "start_game"]);
    assert.deepEqual(await transport.command({ type: "start_game" }), { ok: true });
    assert.deepEqual(await transport.command({ type: "end_game" }), { ok: true });
    const teleport = await transport.command({ type: "teleport", player: "p1", location: "A" });
    assert.equal(teleport.ok, false);
    assert.equal(teleport.unsupported, true);
    // No `headed` argument reaches start_session.
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["StartSession", "StartGame", "StopGame"]);
  } finally {
    await adapter.disconnect();
  }
});
