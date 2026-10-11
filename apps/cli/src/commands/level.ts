import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  LEVEL_SNAPSHOT_FILE,
  diffLevels,
  formatLevelDiff,
  isEditorToolCaller,
  levelDiffIsEmpty,
  parseLevelSnapshot,
  writeLevelSnapshot,
  type DevToolsEngine,
  type LevelCapture,
  type LevelSnapshot,
} from "@uefn-devtools/core";
import { openEngine, print, str, UsageError, type Command } from "../shared.ts";

const USAGE = "usage: uefn level snapshot [--out file] | uefn level diff [before.json] [after.json]";

export const level: Command = {
  name: "level",
  usage: "level snapshot|diff",
  summary: "Snapshot the open UEFN level to a diffable file, or diff two snapshots (or one against the live level)",
  options: { out: { type: "string" } },
  optionHelp: [
    `--out <file>           level snapshot: where to write it (default ${LEVEL_SNAPSHOT_FILE})`,
    "level diff: with no file, compares the saved snapshot with the live level; exits 1 when they differ",
  ],
  async run(values, positionals) {
    const [sub, ...files] = positionals;
    if (sub !== "snapshot" && sub !== "diff") throw new UsageError(USAGE);
    const engine = await openEngine(values);
    try {
      if (sub === "snapshot") {
        if (files.length > 0) throw new UsageError(USAGE);
        const capture = await live(engine);
        const path = resolve(engine.root, str(values, "out") ?? LEVEL_SNAPSHOT_FILE);
        await writeLevelSnapshot(path, capture.snapshot);
        const data = { file: relative(engine.root, path), level: capture.snapshot.level, actors: capture.snapshot.actors.length, errors: capture.errors };
        print(values, data, () => {
          console.log(`Wrote ${data.file}: ${data.actors} actor(s) in ${data.level}`);
          for (const e of capture.errors) console.log(`warning: ${e}`);
        });
        return 0;
      }
      if (files.length > 2) throw new UsageError(USAGE);
      const before = await load(engine.root, files[0] ?? LEVEL_SNAPSHOT_FILE);
      const after = files[1] !== undefined ? await load(engine.root, files[1]) : (await live(engine)).snapshot;
      const diff = diffLevels(before, after);
      print(values, diff, () => console.log(formatLevelDiff(diff)));
      return levelDiffIsEmpty(diff) ? 0 : 1;
    } finally {
      await engine.close();
    }
  },
};

async function live(engine: DevToolsEngine): Promise<LevelCapture> {
  if (!isEditorToolCaller(engine.adapter)) {
    throw new UsageError(`reading the level needs the mcp adapter (the ${engine.adapter.name} adapter has no editor)`);
  }
  return engine.captureLevel();
}

async function load(root: string, file: string): Promise<LevelSnapshot> {
  const path = resolve(root, file);
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new UsageError(`${relative(root, path)} does not exist; run 'uefn level snapshot' first`);
    throw error;
  });
  return parseLevelSnapshot(text, relative(root, path));
}
