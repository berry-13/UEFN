import { readFile, writeFile } from "node:fs/promises";
import { buildProfile, formatProfile, toChromeTrace, type StageMark } from "@uefn-devtools/core";
import { RuntimeEvent } from "@uefn-devtools/protocol";
import { consoleReporter, runTests } from "@uefn-devtools/test";
import { openEngine, print, str, type Command } from "../shared.ts";

export const profile: Command = {
  name: "profile",
  usage: "profile [filter]",
  summary: "Run tests once while profiling, or profile a recorded events.jsonl",
  options: {
    file: { type: "string" },
    out: { type: "string" },
    "chrome-trace": { type: "string" },
  },
  optionHelp: [
    "--file <events.jsonl>  Profile a recorded artifact instead of running tests",
    "--out <profile.json>   Also write the profile as JSON",
    "--chrome-trace <file>  Write a Chrome trace (chrome://tracing, ui.perfetto.dev)",
  ],
  async run(values, positionals) {
    const file = str(values, "file");
    let events: RuntimeEvent[];
    const stages: StageMark[] = [];
    let exitCode = 0;
    if (file) {
      const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l.trim());
      events = lines.map((l) => RuntimeEvent.parse(JSON.parse(l)));
    } else {
      const engine = await openEngine(values);
      try {
        const reporter = values.json ? undefined : consoleReporter();
        const summary = await runTests(engine, {
          ...(positionals[0] ? { filter: positionals[0] } : {}),
          repeat: 1,
          retries: 0,
          onEvent: (event) => {
            // Stage marks on the session clock, so they line up with event timestamps.
            if (event.kind === "stage") {
              stages.push({
                stage: event.stage,
                at: engine.now(),
                ...(event.test !== undefined ? { test: event.test } : {}),
                ...(event.iteration !== undefined ? { iteration: event.iteration } : {}),
              });
            }
            reporter?.(event);
          },
        });
        exitCode = summary.status === "passed" ? 0 : summary.status === "failed" ? 1 : 2;
        events = [...engine.events.all()];
      } finally {
        await engine.close();
      }
    }

    const result = buildProfile(events, stages.length ? { stages } : {});
    const out = str(values, "out");
    if (out) await writeFile(out, JSON.stringify(result, null, 2) + "\n");
    const tracePath = str(values, "chrome-trace");
    if (tracePath) await writeFile(tracePath, JSON.stringify(toChromeTrace(events, { stages })) + "\n");
    print(values, result, () => {
      console.log("");
      console.log(formatProfile(result));
      if (out) console.log(`\nProfile: ${out}`);
      if (tracePath) console.log(`Chrome trace: ${tracePath} (open in chrome://tracing or ui.perfetto.dev)`);
    });
    return exitCode;
  },
};
