import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** A meta-tool server like UEFN 42.30: only list_toolsets / describe_toolset / call_tool are listed. */
async function metaServer(dir: string): Promise<{ script: string; calls: string }> {
  const calls = join(dir, "calls.txt");
  const script = join(dir, "meta.mjs");
  const mcp = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const stdio = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  // zod comes from the protocol package, which depends on it.
  const zod = pathToFileURL(createRequire(fileURLToPath(import.meta.resolve("@uefn-devtools/protocol"))).resolve("zod")).href;
  await writeFile(
    script,
    `import { McpServer } from ${JSON.stringify(mcp)};
import { StdioServerTransport } from ${JSON.stringify(stdio)};
import { z } from ${JSON.stringify(zod)};
import { appendFileSync } from "node:fs";
const server = new McpServer({ name: "fake-uefn-meta", version: "0" });
server.registerTool("list_toolsets", { description: "list" }, async () => ({ content: [{ type: "text", text: "ValkyrieToolset.SessionToolset" }] }));
server.registerTool("describe_toolset", { description: "describe", inputSchema: { toolset_name: z.string() } }, async () => ({ content: [{ type: "text", text: "{}" }] }));
server.registerTool(
  "call_tool",
  { description: "call", inputSchema: { toolset_name: z.string(), tool_name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() } },
  async (a) => {
    appendFileSync(${JSON.stringify(calls)}, a.toolset_name + "/" + a.tool_name + "\\n");
    return { content: [{ type: "text", text: "Completed" }] };
  },
);
await server.connect(new StdioServerTransport());
`,
  );
  await writeFile(calls, "");
  return { script, calls };
}

test("toolset/tool mappings route through call_tool on a meta-tool server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-mcp-meta-"));
  const { script, calls } = await metaServer(dir);
  const log = join(dir, "UnrealEditorFortnite.log");
  await writeFile(log, "");
  const S = "ValkyrieToolset.SessionToolset";
  const adapter = new McpUefnAdapter({
    mcp: McpAdapterConfig.parse({
      command: process.execPath,
      args: [script],
      tools: { start_session: `${S}/StartSession`, start_game: `${S}/StartGame`, end_game: "NotListed" },
      timeout_ms: 20_000,
    }),
    logPath: log,
  });
  try {
    await adapter.connect();
    const report = await adapter.describeCapabilities();
    assert.equal(report.toolsets, S);
    assert.equal(report.capabilities.find((c) => c.feature === "start game")?.status, "DIRECT");
    assert.equal(report.capabilities.find((c) => c.feature === "end game")?.status, "UNKNOWN");
    await adapter.startSession();
    assert.deepEqual([...adapter.transport().supportedCommands()], ["start_game"]);
    assert.deepEqual(await adapter.transport().command({ type: "start_game" }), { ok: true });
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), [`${S}/StartSession`, `${S}/StartGame`]);
  } finally {
    await adapter.disconnect();
  }
});

test("start_game is a no-op when the match already runs (UEFN auto-start)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-mcp-running-"));
  const calls = join(dir, "calls.txt");
  const script = join(dir, "running.mjs");
  const mcp = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const stdio = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  await writeFile(
    script,
    `import { McpServer } from ${JSON.stringify(mcp)};
import { StdioServerTransport } from ${JSON.stringify(stdio)};
import { appendFileSync } from "node:fs";
const server = new McpServer({ name: "fake-uefn-running", version: "0" });
const reply = { StartSession: "null", StartGame: '"refused"', StopGame: "null", GetGameState: '"Running"' };
for (const [name, value] of Object.entries(reply)) {
  server.registerTool(name, { description: name }, async () => {
    appendFileSync(${JSON.stringify(calls)}, name + "\\n");
    return { content: [{ type: "text", text: '{"returnValue":' + value + "}" }], isError: name === "StartGame" };
  });
}
await server.connect(new StdioServerTransport());
`,
  );
  await writeFile(calls, "");
  const log = join(dir, "UnrealEditorFortnite.log");
  await writeFile(log, "");
  const adapter = new McpUefnAdapter({
    mcp: McpAdapterConfig.parse({
      command: process.execPath,
      args: [script],
      tools: { start_session: "StartSession", start_game: "StartGame", end_game: "StopGame", game_state: "GetGameState" },
      timeout_ms: 20_000,
    }),
    logPath: log,
  });
  try {
    await adapter.connect();
    await adapter.startSession();
    assert.deepEqual(await adapter.transport().command({ type: "start_game" }), { ok: true, noop: true });
    assert.deepEqual(await adapter.transport().command({ type: "end_game" }), { ok: true });
    // StartGame was never sent; StopGame was, because the match was running.
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["StartSession", "GetGameState", "GetGameState", "StopGame"]);
  } finally {
    await adapter.disconnect();
  }
});
