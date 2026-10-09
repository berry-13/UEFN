import { openEngine, str, UsageError, type Command } from "../shared.ts";

export const mcp: Command = {
  name: "mcp",
  usage: "mcp",
  summary: "Serve the DevTools MCP server over stdio",
  options: { mode: { type: "string" } },
  optionHelp: ["--mode <mode>          read_only | development | full_access"],
  async run(values) {
    const mode = str(values, "mode");
    if (mode !== undefined && mode !== "read_only" && mode !== "development" && mode !== "full_access") {
      throw new UsageError(`unknown mode '${mode}'`);
    }
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { createDevToolsMcpServer } = await import("@uefn-devtools/mcp");
    const engine = await openEngine(values);
    const server = createDevToolsMcpServer({ engine, ...(mode ? { mode } : {}) });
    await server.connect(new StdioServerTransport());
    const shutdown = async () => {
      await engine.close().catch(() => {});
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return new Promise<number>(() => {});
  },
};
