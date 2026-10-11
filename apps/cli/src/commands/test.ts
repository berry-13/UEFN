import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { createReporters, runTests } from "@uefn-devtools/test";
import { int, list, openEngine, str, type Command, type Values } from "../shared.ts";
import { assertInteractive, startInteractive } from "../interactive.ts";

export const test: Command = {
  name: "test",
  usage: "test [filter]",
  summary: "Compile, start/reuse a session, run tests, assert",
  options: {
    id: { type: "string", multiple: true },
    repeat: { type: "string" },
    seed: { type: "string" },
    retries: { type: "string" },
    "no-compile": { type: "boolean" },
    watch: { type: "boolean" },
    verbose: { type: "boolean" },
    reporter: { type: "string", multiple: true },
    output: { type: "string" },
    "update-snapshots": { type: "boolean" },
    headed: { type: "boolean" },
    debug: { type: "boolean" },
  },
  optionHelp: [
    "--id <id>              Run exactly this test id (repeatable; no substring match)",
    "--repeat <n>           Run each test n times and report reliability",
    "--seed <n>             Base seed (iteration i uses seed+i)",
    "--retries <n>          Retries per failing test (ignored with --repeat)",
    "--no-compile           Skip the Verse build stage",
    "--watch                Re-run when Verse or test files change",
    "--verbose              Print every iteration with --repeat",
    "--reporter <name>      console | json | junit | github (repeat or comma-separate;",
    "                       github is added automatically when GITHUB_ACTIONS=true)",
    "--output <file>        junit/json output file (default <paths.results>/junit.xml)",
    "--update-snapshots     Write/overwrite state snapshots instead of comparing",
    "--headed               Show the running game (live state view; hint to the mcp adapter)",
    "--debug                Pause before each step and on failure (TTY; implies --repeat 1)",
  ],
  async run(values, positionals) {
    if (values.watch) return watchTests(values);
    assertInteractive(values);
    const engine = await openEngine(values);
    const interactive = startInteractive(values, engine);
    try {
      const repeat = int(str(values, "repeat"), "repeat");
      const seed = int(str(values, "seed"), "seed");
      const retries = int(str(values, "retries"), "retries");
      const reporters = list(values, "reporter");
      const output = str(values, "output");
      const reporter =
        values.json && !reporters?.length
          ? undefined
          : createReporters({
              ...(reporters ? { reporters } : {}),
              ...(output ? { output } : {}),
              root: engine.root,
              resultsDir: resolve(engine.root, engine.config.paths.results),
              verbose: values.verbose === true,
              ...(values.json ? { stdoutJson: true } : {}),
              ...interactive.reporter,
            });
      const ids = list(values, "id");
      const summary = await runTests(engine, {
        ...(positionals[0] ? { filter: positionals[0] } : {}),
        ...(ids?.length ? { ids } : {}),
        ...(repeat !== undefined ? { repeat } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(retries !== undefined ? { retries } : {}),
        skipBuild: values["no-compile"] === true,
        ...(values["update-snapshots"] ? { updateSnapshots: true } : {}),
        ...(reporter ? { onEvent: reporter } : {}),
        ...interactive.runOptions,
      });
      if (values.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      const code = summary.status === "passed" ? 0 : summary.status === "failed" ? 1 : 2;
      return code === 0 && reporter?.failures.length ? 2 : code;
    } finally {
      interactive.stop();
      await engine.close();
    }
  },
};

/** Each run is a fresh process so edited test modules are re-imported. */
async function watchTests(values: Values): Promise<number> {
  const engine = await openEngine(values);
  const dirs = [engine.config.paths.verse, engine.config.paths.tests].map((d) => resolve(engine.root, d));
  const args = process.argv.slice(2).filter((a) => a !== "--watch");
  let running = false;
  let queued = false;
  const run = () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    console.clear();
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...args], { stdio: "inherit" });
    child.on("exit", () => {
      running = false;
      console.log("\nWatching for changes… (Ctrl+C to exit)");
      if (queued) {
        queued = false;
        run();
      }
    });
  };
  let debounce: NodeJS.Timeout | undefined;
  for (const dir of dirs) {
    try {
      watch(dir, { recursive: true }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(run, 200);
      });
    } catch {
      // Missing directory: nothing to watch there.
    }
  }
  run();
  return new Promise<number>(() => {});
}
