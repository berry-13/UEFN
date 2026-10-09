import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Vector3 } from "@uefn-devtools/protocol";
import { parseDuration } from "@uefn-devtools/protocol";
import { findYamlTest, generateScenario } from "@uefn-devtools/test";
import { openEngine, print, str, UsageError, type Command } from "../shared.ts";

export const scenario: Command = {
  name: "scenario",
  usage: "scenario <test-id>",
  summary: "Generate the in-game Verse device that performs a YAML test's player actions",
  options: { out: { type: "string" } },
  optionHelp: ["--out <dir>            Where to write the .verse file (default scenario.output)"],
  async run(values, positionals) {
    const id = positionals[0];
    if (!id) throw new UsageError("usage: uefn scenario <test-id>");
    const engine = await openEngine(values);
    try {
      const config = engine.config;
      // Only YAML tests are read, and only as data: nothing in the project is executed.
      const found = await findYamlTest(resolve(engine.root, config.paths.tests), id);
      if (!found) throw new UsageError(`no YAML test with id '${id}' (scenarios are generated from YAML tests)`);

      // Named positions: scenario.locations first, then simulator device locations.
      const locations: Record<string, Vector3> = {};
      for (const d of config.simulated.devices) if (d.location) locations[d.id] = d.location;
      Object.assign(locations, config.scenario.locations);

      const generated = generateScenario(found.test, { id, locations, startDelayMs: parseDuration(config.scenario.start_delay) });
      const dir = resolve(engine.root, str(values, "out") ?? config.scenario.output);
      await mkdir(dir, { recursive: true });
      const path = join(dir, generated.fileName);
      await writeFile(path, generated.verse);
      const data = { test: id, file: relative(engine.root, path), className: generated.className, plan: generated.plan, warnings: generated.warnings };
      print(values, data, () => {
        console.log(`Wrote ${data.file} (${generated.plan.length} step(s) from ${relative(engine.root, found.file)})`);
        for (const s of generated.plan) console.log(`  ${s.index}. ${s.description}`);
        for (const w of generated.warnings) console.log(`warning: ${w}`);
        console.log(`\nNext: compile, place one ${generated.className} device in the level, and set scenario.enabled: true.`);
        if (!config.scenario.enabled) console.log("scenario.enabled is false, so player actions are not routed to the device yet.");
      });
      return 0;
    } finally {
      await engine.close();
    }
  },
};
