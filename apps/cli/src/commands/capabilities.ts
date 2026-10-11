import { openEngine, print, type Command } from "../shared.ts";

export const capabilities: Command = {
  name: "capabilities",
  usage: "capabilities",
  summary: "What the adapter can do (DIRECT/INSTRUMENTED/...)",
  async run(values) {
    const engine = await openEngine(values);
    try {
      const report = await engine.capabilities();
      print(values, report, () => {
        console.log(`Adapter: ${report.adapter}\n`);
        for (const c of report.capabilities) {
          console.log(`${c.status.padEnd(13)} ${c.feature}${c.via ? `  [${c.via}]` : ""}${c.notes ? `\n${" ".repeat(14)}${c.notes}` : ""}`);
        }
        if (report.tools) {
          console.log(`\nTools exposed by the UEFN MCP server (${report.tools.length}):`);
          for (const t of report.tools) console.log(`  ${t.name}${t.description ? `: ${t.description.split("\n")[0]}` : ""}`);
        }
      });
      return 0;
    } finally {
      await engine.close();
    }
  },
};
