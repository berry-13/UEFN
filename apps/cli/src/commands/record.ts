import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { Recorder, loadRecording, recordingPath, saveRecording, type DevToolsEngine, type Recording } from "@uefn-devtools/core";
import { parseDuration } from "@uefn-devtools/protocol";
import { TestContext, createFixtures, generateYamlTest, loadStepScript, runStep, slugify } from "@uefn-devtools/test";
import { openEngine, str, type Command } from "../shared.ts";

export interface RecordOptions {
  name?: string;
  /** Session-clock duration (`30s`); interactive recordings also stop on Ctrl+C. */
  duration?: string;
  /** Where to write the generated test (default `<paths.tests>/<name>.test.yaml`). */
  out?: string;
  /** Drive the simulator with these steps instead of waiting for a player. */
  script?: string;
  force?: boolean;
  /** Regenerate a test from a saved recording instead of recording. */
  from?: string;
  json?: boolean;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

function defaultName(): string {
  return `recording-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
}

async function refuseOverwrite(engine: DevToolsEngine, target: string, force: boolean | undefined): Promise<void> {
  if (!force && (await exists(target))) {
    throw new Error(`${relative(engine.root, target)} already exists; pass --force to overwrite it`);
  }
}

async function writeTest(recording: Recording, target: string, name: string): Promise<void> {
  const { yaml } = generateYamlTest(recording, { name });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, yaml);
}

/** `uefn record`: observe a session (or a scripted run) and turn it into a test. */
export async function cmdRecord(engine: DevToolsEngine, options: RecordOptions): Promise<number> {
  const log = (line: string) => {
    if (!options.json) console.log(line);
  };
  const testPath = (slug: string) => resolve(engine.root, options.out ?? `${engine.config.paths.tests}/${slug}.test.yaml`);
  const rel = (path: string) => relative(engine.root, path);

  if (options.from) {
    const recording = await loadRecording(resolve(options.from));
    const name = options.name ?? recording.name;
    const target = testPath(slugify(name));
    await refuseOverwrite(engine, target, options.force);
    await writeTest(recording, target, name);
    log(`Generated ${rel(target)} from ${options.from}`);
    if (options.json) process.stdout.write(JSON.stringify({ test: rel(target), events: recording.events.length }, null, 2) + "\n");
    return 0;
  }

  const name = options.name ?? defaultName();
  const slug = slugify(name);
  const target = testPath(slug);
  await refuseOverwrite(engine, target, options.force);
  const script = options.script ? await loadStepScript(resolve(options.script)) : undefined;
  const durationMs = parseDuration(options.duration ?? "30s");

  await engine.startSession();
  await engine.waitForRuntime();
  if (script) {
    // Same preparation the runner does, so the generated test replays the same world.
    if (engine.supportsCommand("reset")) await engine.command({ type: "reset" });
    if (engine.supportsCommand("seed")) await engine.command({ type: "seed", seed: 1 });
  }
  engine.resetObservedState();
  const recorder = new Recorder(engine, { name: slug });
  recorder.start();

  if (script) {
    log(`Recording '${slug}' (scripted, ${script.length} step(s))`);
    const ctx = new TestContext(
      engine,
      engine.events.mark(),
      parseDuration(engine.config.tests.expect_timeout),
      parseDuration(engine.config.tests.expect_settle),
    );
    const { game } = createFixtures(ctx);
    for (const step of script) await runStep(game, step);
  } else {
    log(`Recording '${slug}' for ${options.duration ?? "30s"}. Press Ctrl+C to stop early.`);
    let interrupt: () => void = () => {};
    const interrupted = new Promise<void>((resolveInterrupt) => {
      interrupt = resolveInterrupt;
    });
    process.once("SIGINT", interrupt);
    await Promise.race([engine.sleep(durationMs), interrupted]);
    process.off("SIGINT", interrupt);
  }

  // Let in-flight consequences (the next tick's state change) land so the end state is the settled one.
  await engine.sleep(parseDuration(engine.config.tests.expect_settle) * 2);
  const recording = recorder.stop();
  const file = recordingPath(engine.root, slug);
  await saveRecording(recording, file);
  log(`Saved ${recording.events.length} event(s) to ${rel(file)}`);
  if (recording.events.length === 0) {
    log("Nothing was observed; skipping test generation.");
    return 1;
  }
  await writeTest(recording, target, name);
  log(`Generated ${rel(target)}`);
  log(`Run it with: uefn test ${slug}`);
  if (options.json) {
    process.stdout.write(JSON.stringify({ recording: rel(file), test: rel(target), events: recording.events.length }, null, 2) + "\n");
  }
  return 0;
}

export const record: Command = {
  name: "record",
  usage: "record [name]",
  summary: "Record a session and generate a YAML test from it",
  options: {
    duration: { type: "string" },
    out: { type: "string" },
    script: { type: "string" },
    from: { type: "string" },
    force: { type: "boolean" },
  },
  optionHelp: [
    "--duration <d>         Stop after this long (default 30s); Ctrl+C stops early",
    "--out <path>           Generated test file (default <tests>/<name>.test.yaml)",
    "--script <file>        Drive the simulator with YAML steps (non-interactive)",
    "--from <file>          Regenerate a test from a saved .uefnrec.json recording",
    "--force                Overwrite an existing test file",
  ],
  async run(values, positionals) {
    const engine = await openEngine(values);
    try {
      const duration = str(values, "duration");
      const out = str(values, "out");
      const script = str(values, "script");
      const from = str(values, "from");
      return await cmdRecord(engine, {
        ...(positionals[0] ? { name: positionals[0] } : {}),
        ...(duration ? { duration } : {}),
        ...(out ? { out } : {}),
        ...(script ? { script } : {}),
        ...(from ? { from } : {}),
        ...(values.json ? { json: true } : {}),
        force: values.force === true,
      });
    } finally {
      await engine.close();
    }
  },
};
