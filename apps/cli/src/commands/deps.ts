import {
  buildDepsGraph,
  changedFiles,
  exportDot,
  exportJson,
  exportMermaid,
  formatDepsText,
  impactOfAll,
  loadConfig,
  type DepNode,
} from "@uefn-devtools/core";
import { str, UsageError, type Command } from "../shared.ts";

const FORMATS = ["text", "json", "dot", "mermaid"] as const;

function where(n: DepNode): string {
  return n.file ? `${n.file}${n.line ? `:${n.line}` : ""}` : "";
}

export const deps: Command = {
  name: "deps",
  usage: "deps",
  summary: "Verse dependency graph and test impact",
  options: {
    format: { type: "string" },
    impact: { type: "string" },
    changed: { type: "boolean" },
  },
  optionHelp: [
    "--format <fmt>         text | json | dot | mermaid (default text)",
    "--impact <file|name>   Tests affected by changing a Verse file or symbol",
    "--changed              Tests affected by files git reports as changed",
  ],
  async run(values) {
    const format = str(values, "format") ?? (values.json ? "json" : "text");
    if (!(FORMATS as readonly string[]).includes(format)) {
      throw new UsageError(`unknown format '${format}' (expected ${FORMATS.join(", ")})`);
    }
    const loaded = await loadConfig(process.cwd(), str(values, "config"));
    const graph = await buildDepsGraph(loaded);

    const impact = str(values, "impact");
    if (impact === undefined && !values.changed) {
      switch (format) {
        case "json":
          console.log(exportJson(graph));
          break;
        case "dot":
          console.log(exportDot(graph));
          break;
        case "mermaid":
          console.log(exportMermaid(graph));
          break;
        default:
          console.log(formatDepsText(graph));
      }
      return 0;
    }

    const targets = impact !== undefined ? [impact] : await changedFiles(loaded.root);
    const result = impactOfAll(graph, targets);
    if (impact !== undefined && result.seeds.length === 0) {
      console.error(`no Verse file or symbol matches '${impact}'`);
      return 2;
    }
    if (format === "json") {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (result.tests.length === 0) {
      console.log(impact === undefined && targets.length === 0 ? "No changed files." : "No tests affected.");
    } else if (format === "text") {
      console.log(`${result.tests.length} affected test(s):`);
      for (const t of result.tests) console.log(`  ${t.label}  (${where(t)})`);
    } else {
      for (const t of result.tests) console.log(t.label);
    }
    return 0;
  },
};
