import { readFile } from "node:fs/promises";
import { RunSummary } from "@uefn-devtools/protocol";
import { renderMarkdown } from "@uefn-devtools/test";
import { str, UsageError, type Command } from "../shared.ts";

export const ci: Command = {
  name: "ci",
  usage: "ci comment",
  summary: "Render the Markdown summary of a saved summary.json",
  options: { from: { type: "string" } },
  optionHelp: ["--from <summary.json>  Saved run summary (from .devtools/results/...)"],
  run(values, positionals) {
    if (positionals[0] !== "comment") throw new UsageError("usage: uefn ci comment --from <summary.json>");
    return cmdCiComment(str(values, "from"));
  },
};

/** `uefn ci comment --from <summary.json>`: PR comment Markdown on stdout. */
export async function cmdCiComment(from: string | undefined): Promise<number> {
  if (!from) {
    console.error("usage: uefn ci comment --from <summary.json>");
    return 2;
  }
  let summary: RunSummary;
  try {
    summary = RunSummary.parse(JSON.parse(await readFile(from, "utf8")));
  } catch (error) {
    console.error(`cannot read run summary '${from}': ${(error as Error).message}`);
    return 2;
  }
  const env = process.env;
  const runUrl =
    env["GITHUB_SERVER_URL"] && env["GITHUB_REPOSITORY"] && env["GITHUB_RUN_ID"]
      ? `${env["GITHUB_SERVER_URL"]}/${env["GITHUB_REPOSITORY"]}/actions/runs/${env["GITHUB_RUN_ID"]}`
      : undefined;
  process.stdout.write(renderMarkdown(summary, { marker: true, ...(runUrl ? { runUrl } : {}) }));
  return 0;
}
