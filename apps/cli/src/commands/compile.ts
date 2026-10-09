import { openEngine, print, type Command } from "../shared.ts";

export const compile: Command = {
  name: "compile",
  usage: "compile",
  summary: "Compile Verse through the adapter",
  async run(values) {
    const engine = await openEngine(values);
    try {
      const result = await engine.compile();
      print(values, result, () => {
        for (const d of result.diagnostics) {
          const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}: ` : "";
          console.log(`${d.severity.padEnd(7)} ${where}${d.message}`);
        }
        console.log(result.success ? `Verse ✓ (${result.durationMs.toFixed(0)}ms)` : "Verse ✗");
      });
      return result.success ? 0 : 1;
    } finally {
      await engine.close();
    }
  },
};
