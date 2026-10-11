import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const snap = (actors: unknown[]) => JSON.stringify({ version: 1, level: "/Game/L", actors });
const pump = { id: "G1", label: "Pump", class: "/D/Pump.Pump_C", path: "/Game/L:P.Pump", location: [0, 0, 0] };

test("level diff compares two files and exits 1 only when they differ; the simulator has no level", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-level-"));
  try {
    await writeFile(join(dir, "uefn-devtools.config.yaml"), "adapter: simulated\n");
    await writeFile(join(dir, "a.json"), snap([pump]));
    await writeFile(join(dir, "b.json"), snap([{ ...pump, location: [10, 0, 0] }]));
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });

    const same = run("level", "diff", "a.json", "a.json");
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /0 added, 0 removed, 0 changed/);

    const moved = run("level", "diff", "a.json", "b.json");
    assert.equal(moved.status, 1, moved.stderr);
    assert.match(moved.stdout, /~ Pump\n {4}location: \(0, 0, 0\) -> \(10, 0, 0\)/);

    const missing = run("level", "diff");
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /level\.snapshot\.json does not exist; run 'uefn level snapshot' first/);

    const simulated = run("level", "snapshot");
    assert.equal(simulated.status, 2);
    assert.match(simulated.stderr, /needs the mcp adapter/);

    assert.equal(run("level", "nope").status, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
