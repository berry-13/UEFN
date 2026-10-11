import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { McpAdapterConfig, type RuntimeEvent } from "@uefn-devtools/protocol";
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

/** A meta-tool server like UEFN 42.30: only list_toolsets / describe_toolset / call_tool are listed, and describe_toolset names tools `<toolset>.<tool>`. */
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
server.registerTool("describe_toolset", { description: "describe", inputSchema: { toolset_name: z.string() } }, async (a) =>
  a.toolset_name === "ValkyrieToolset.SessionToolset"
    ? { content: [{ type: "text", text: JSON.stringify({ returnValue: { tools: ["StartSession", "StartGame", "StopGame"].map((t) => ({ name: "ValkyrieToolset.SessionToolset." + t })) } }) }] }
    : { content: [{ type: "text", text: "Unknown toolset " + a.toolset_name }], isError: true },
);
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
      tools: {
        start_session: `${S}/StartSession`,
        start_game: `${S}/StartGame`,
        end_game: "NotListed",
        // A typo in the tool, and a toolset the server does not have.
        stop_session: `${S}/StopSesion`,
        game_state: "ValkyrieToolset.Missing/GetGameState",
      },
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
    assert.equal(report.capabilities.find((c) => c.feature === "stop session")?.status, "UNKNOWN");
    assert.equal(adapter.hasTool("ValkyrieToolset.Missing/GetGameState"), false);
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
    const events = adapter.transport().receive()[Symbol.asyncIterator]();
    assert.deepEqual(await adapter.transport().command({ type: "start_game" }), { ok: true, noop: true });
    // The auto-started match is reported, so the phase is playing and cleanup ends it.
    const started = (await events.next()).value as RuntimeEvent;
    assert.equal(started.type, "game.started");
    assert.equal(started.payload["alreadyRunning"], true);
    assert.deepEqual(await adapter.transport().command({ type: "end_game" }), { ok: true });
    // StartGame was never sent; StopGame was, because the match was running.
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["StartSession", "GetGameState", "GetGameState", "StopGame"]);
  } finally {
    await adapter.disconnect();
  }
});

/**
 * A server whose GetSessionStatus answers `statuses` in turn (the last one
 * repeating) and whose StartSession `exit`s the process, `hang`s, or succeeds.
 * Each process start and each call is appended to the calls file.
 */
async function sessionServer(dir: string, statuses: string[], startSession: "ok" | "exit" | "hang"): Promise<{ script: string; calls: string }> {
  const calls = join(dir, "calls.txt");
  const script = join(dir, "session.mjs");
  const mcp = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const stdio = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  await writeFile(
    script,
    `import { McpServer } from ${JSON.stringify(mcp)};
import { StdioServerTransport } from ${JSON.stringify(stdio)};
import { appendFileSync } from "node:fs";
const log = (line) => appendFileSync(${JSON.stringify(calls)}, line + "\\n");
log("spawn");
const statuses = ${JSON.stringify(statuses)};
let n = 0;
const server = new McpServer({ name: "fake-uefn-session", version: "0" });
server.registerTool("GetSessionStatus", { description: "status" }, async () => {
  log("GetSessionStatus");
  const status = statuses[Math.min(n++, statuses.length - 1)];
  return { content: [{ type: "text", text: JSON.stringify({ returnValue: status }) }] };
});
server.registerTool("StartSession", { description: "start" }, async () => {
  log("StartSession");
  if (${JSON.stringify(startSession)} === "exit") process.exit(1);
  if (${JSON.stringify(startSession)} === "hang") await new Promise((r) => setTimeout(r, 10_000));
  return { content: [{ type: "text", text: '{"returnValue":null}' }] };
});
await server.connect(new StdioServerTransport());
`,
  );
  await writeFile(calls, "");
  return { script, calls };
}

function sessionAdapter(script: string, log: string, timeoutMs = 20_000): McpUefnAdapter {
  return new McpUefnAdapter({
    mcp: McpAdapterConfig.parse({
      command: process.execPath,
      args: [script],
      tools: { start_session: "StartSession", session_state: "GetSessionStatus" },
      timeout_ms: timeoutMs,
    }),
    logPath: log,
    sessionPollMs: 10,
  });
}

test("a session that is still starting is joined, and its earlier hello is replayed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-mcp-starting-"));
  const { script, calls } = await sessionServer(dir, ["Connecting", "UpdatingContent", "Connected"], "ok");
  const log = join(dir, "UnrealEditorFortnite.log");
  await writeFile(
    log,
    [
      "[2026.10.09-10.00.00:000][  1]LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|H|0|0.1.0",
      "[2026.10.09-10.00.01:000][  2]LogValkyrieBeacon: [3974] (ValkyrieBeaconClient_3) MinigameStateChanged: EFortMinigameState::InProgress",
      "",
    ].join("\n"),
  );
  const adapter = sessionAdapter(script, log);
  try {
    await adapter.connect();
    const session = await adapter.startSession();
    assert.equal(session.reused, true);
    await adapter.transport().start();
    const events = adapter.transport().receive()[Symbol.asyncIterator]();
    assert.equal(((await events.next()).value as RuntimeEvent).type, "session.ready");
    assert.equal(((await events.next()).value as RuntimeEvent).type, "game.started");
    // No second launch: StartSession was never sent.
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["spawn", "GetSessionStatus", "GetSessionStatus", "GetSessionStatus"]);
  } finally {
    await adapter.disconnect();
  }
});

test("concurrent connects share one MCP server process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-mcp-connect-"));
  const { script, calls } = await sessionServer(dir, ["Disconnected"], "ok");
  const adapter = sessionAdapter(script, join(dir, "UnrealEditorFortnite.log"));
  try {
    await Promise.all([adapter.connect(), adapter.connect(), adapter.connect()]);
    assert.equal(await adapter.getSessionStatus(), "none");
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["spawn", "GetSessionStatus"]);
  } finally {
    await adapter.disconnect();
  }
});

test("only a StartSession timeout is reported as a stalled launch", async () => {
  const hung = await mkdtemp(join(tmpdir(), "uefn-mcp-hang-"));
  const slow = sessionAdapter((await sessionServer(hung, ["Disconnected"], "hang")).script, join(hung, "u.log"), 300);
  try {
    await slow.connect();
    await assert.rejects(slow.startSession(), /did not finish launching the session/);
  } finally {
    await slow.disconnect();
  }
  const crashed = await mkdtemp(join(tmpdir(), "uefn-mcp-exit-"));
  const broken = sessionAdapter((await sessionServer(crashed, ["Disconnected"], "exit")).script, join(crashed, "u.log"));
  try {
    await broken.connect();
    await assert.rejects(broken.startSession(), (error: Error) => !/did not finish launching/.test(error.message));
  } finally {
    await broken.disconnect().catch(() => {});
  }
});

test("scenario mode restarts a reused session's running match so its device runs again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-mcp-restart-"));
  const calls = join(dir, "calls.txt");
  const script = join(dir, "restart.mjs");
  const mcp = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const stdio = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  // A connected session whose match runs; StopGame ends it, StartGame starts one.
  await writeFile(
    script,
    `import { McpServer } from ${JSON.stringify(mcp)};
import { StdioServerTransport } from ${JSON.stringify(stdio)};
import { appendFileSync } from "node:fs";
const server = new McpServer({ name: "fake-uefn-restart", version: "0" });
let state = "Running";
const tools = {
  GetSessionStatus: () => "Connected",
  GetGameState: () => state,
  StopGame: () => { state = "CanStart"; return null; },
  StartGame: () => { const ok = state === "CanStart"; state = "Running"; return ok ? null : "refused"; },
};
for (const [name, fn] of Object.entries(tools)) {
  server.registerTool(name, { description: name }, async () => {
    appendFileSync(${JSON.stringify(calls)}, name + "\\n");
    const value = fn();
    return { content: [{ type: "text", text: JSON.stringify({ returnValue: value }) }], isError: value === "refused" };
  });
}
await server.connect(new StdioServerTransport());
`,
  );
  await writeFile(calls, "");
  const log = join(dir, "UnrealEditorFortnite.log");
  await writeFile(log, "[2026.10.09-10.00.01:000][  2]LogValkyrieBeacon: [3974] (ValkyrieBeaconClient_3) MinigameStateChanged: EFortMinigameState::InProgress\n");
  const adapter = new McpUefnAdapter({
    mcp: McpAdapterConfig.parse({
      command: process.execPath,
      args: [script],
      tools: { start_session: "StartSession", session_state: "GetSessionStatus", start_game: "StartGame", end_game: "StopGame", game_state: "GetGameState" },
      timeout_ms: 20_000,
    }),
    logPath: log,
    sessionPollMs: 10,
    scenario: { stepTimeoutMs: 1000 },
  });
  try {
    await adapter.connect();
    assert.equal((await adapter.startSession()).reused, true);
    // Not a no-op: the match was restarted, so the caller waits for its start.
    assert.deepEqual(await adapter.transport().command({ type: "start_game" }), { ok: true });
    // Only the first start restarts; later attempts start normally.
    assert.deepEqual(await adapter.transport().command({ type: "start_game" }), { ok: true, noop: true });
    const sent = (await readFile(calls, "utf8")).trim().split("\n").filter((c) => c === "StopGame" || c === "StartGame");
    assert.deepEqual(sent, ["StopGame", "StartGame"]);
  } finally {
    await adapter.disconnect();
  }
});

test("a hello logged while StartSession is still running is not missed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-mcp-launch-"));
  const script = join(dir, "launch.mjs");
  const log = join(dir, "UnrealEditorFortnite.log");
  await writeFile(log, "[2026.10.11-10.00.00:000][  1]LogTemp: before the launch\n");
  const mcp = import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const stdio = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  // Seen live: with the client already up, the match starts (and the runtime
  // says hello) before StartSession returns.
  await writeFile(
    script,
    `import { McpServer } from ${JSON.stringify(mcp)};
import { StdioServerTransport } from ${JSON.stringify(stdio)};
import { appendFileSync } from "node:fs";
const server = new McpServer({ name: "fake-uefn-launch", version: "0" });
let status = "Disconnected";
server.registerTool("GetSessionStatus", { description: "s" }, async () => ({ content: [{ type: "text", text: JSON.stringify({ returnValue: status }) }] }));
server.registerTool("StartSession", { description: "s" }, async () => {
  appendFileSync(${JSON.stringify(log)}, "[2026.10.11-11.00.26:222][702]LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|H|0|0.1.0\\n");
  status = "Connected";
  return { content: [{ type: "text", text: '{"returnValue":"Completed"}' }] };
});
await server.connect(new StdioServerTransport());
`,
  );
  const adapter = sessionAdapter(script, log);
  try {
    await adapter.connect();
    assert.equal((await adapter.startSession()).reused, false);
    await adapter.transport().start();
    const events = adapter.transport().receive()[Symbol.asyncIterator]();
    assert.equal(((await events.next()).value as RuntimeEvent).type, "session.ready");
  } finally {
    await adapter.disconnect();
  }
});
