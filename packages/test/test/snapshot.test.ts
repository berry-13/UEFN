import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DevToolsEngine } from "@uefn-devtools/core";
import { emptyGameState, type GameState } from "@uefn-devtools/protocol";
import { YamlTestSchema, diffSnapshots, runTests, snapshotState } from "@uefn-devtools/test";

const CONFIG = `
adapter: simulated
simulated:
  time_scale: 100
  boot_ms: 100
  devices:
    - id: A
      capture_time_ms: 2000
      score: 50
tests:
  expect_timeout: 5s
`;

const YAML_TEST = `
name: Capture A
setup:
  - start_game
  - spawn_player: { id: p1, team: 1 }
steps:
  - teleport: { player: p1, location: A }
  - wait_for: { event: CaptureCompleted, timeout: 5s }
assert:
  - snapshot: captured
`;

async function project(): Promise<{ dir: string; snap: string }> {
  const dir = await mkdtemp(join(tmpdir(), "uefn-snap-"));
  await writeFile(join(dir, "uefn-devtools.config.yaml"), CONFIG);
  await mkdir(join(dir, "Tests"));
  await writeFile(join(dir, "Tests", "a.test.yaml"), YAML_TEST);
  return { dir, snap: join(dir, "Tests", "__snapshots__", "a.test.yaml.snap.json") };
}

async function run(dir: string, options: { updateSnapshots?: boolean } = {}) {
  const engine = await DevToolsEngine.open({ cwd: dir });
  try {
    return await runTests(engine, options);
  } finally {
    await engine.close();
  }
}

async function withCi<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env["CI"];
  if (value === undefined) delete process.env["CI"];
  else process.env["CI"] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env["CI"];
    else process.env["CI"] = previous;
  }
}

const failure = (summary: Awaited<ReturnType<typeof run>>) => summary.tests[0]!.attempts[0]!.assertions.find((a) => !a.passed);

test("a missing snapshot is written and passes, then matches on the next run", async () => {
  const { dir, snap } = await project();
  await withCi(undefined, async () => {
    const first = await run(dir);
    assert.equal(first.status, "passed", JSON.stringify(first, null, 2));
    assert.match(first.tests[0]!.attempts[0]!.assertions.at(-1)!.description, /written/);
    const stored = JSON.parse(await readFile(snap, "utf8"));
    const state = stored.snapshots["capture-a::captured"];
    assert.equal(state.devices.A.state, "Captured");
    assert.equal(state.teams["1"].score, 50);
    assert.equal(state.players.p1.position, undefined, "positions are dropped by default");

    const second = await run(dir);
    assert.equal(second.status, "passed");
    assert.match(second.tests[0]!.attempts[0]!.assertions.at(-1)!.description, /matches/);
  });
});

test("a mismatch fails with a readable structural diff", async () => {
  const { dir, snap } = await project();
  await withCi(undefined, async () => {
    await run(dir);
    const stored = JSON.parse(await readFile(snap, "utf8"));
    stored.snapshots["capture-a::captured"].teams["1"].score = 99;
    stored.snapshots["capture-a::captured"].devices.A.state = "Neutral";
    await writeFile(snap, JSON.stringify(stored));

    const summary = await run(dir);
    assert.equal(summary.status, "failed");
    const message = failure(summary)!.message!;
    assert.match(message, /teams\.1\.score: expected 99, received 50/);
    assert.match(message, /devices\.A\.state: expected "Neutral", received "Captured"/);
  });
});

test("CI mode refuses to write a missing snapshot", async () => {
  const { dir, snap } = await project();
  await withCi("true", async () => {
    const summary = await run(dir);
    assert.equal(summary.status, "failed");
    assert.match(failure(summary)!.message!, /missing .* CI is set/);
    await assert.rejects(stat(snap));
    // Explicit update mode still writes, like Jest's --ci combined with -u.
    const updated = await run(dir, { updateSnapshots: true });
    assert.equal(updated.status, "passed");
    await stat(snap);
  });
});

test("update mode overwrites a stale snapshot", async () => {
  const { dir, snap } = await project();
  await withCi(undefined, async () => {
    await run(dir);
    const original = await readFile(snap, "utf8");
    const stale = JSON.parse(original);
    stale.snapshots["capture-a::captured"].teams["1"].score = 1;
    await writeFile(snap, JSON.stringify(stale));
    assert.equal((await run(dir)).status, "failed");

    const summary = await run(dir, { updateSnapshots: true });
    assert.equal(summary.status, "passed");
    assert.match(summary.tests[0]!.attempts[0]!.assertions.at(-1)!.description, /updated/);
    assert.equal(await readFile(snap, "utf8"), original);
    assert.equal((await run(dir)).status, "passed");
  });
});

test("the yaml schema accepts snapshot assertions", () => {
  const base = { name: "t", steps: [], setup: [] };
  assert.ok(YamlTestSchema.safeParse({ ...base, assert: [{ snapshot: "end" }] }).success);
  assert.ok(
    YamlTestSchema.safeParse({
      ...base,
      assert: [{ snapshot: { name: "end", include: ["devices", "teams"], ignore: ["players.*.health"] } }],
    }).success,
  );
  assert.ok(!YamlTestSchema.safeParse({ ...base, assert: [{ snapshot: { include: ["bogus"] } }] }).success);
});

test("snapshotState drops volatile fields and diffSnapshots reports paths", () => {
  const state: GameState = {
    ...emptyGameState(),
    phase: "playing",
    round: 1,
    startedAt: 1234,
    players: {
      p1: { id: "p1", alive: true, score: 0, eliminations: 0, deaths: 0, areas: ["B", "A"], position: [1, 2, 3], extra: {} },
    },
    teams: { "1": { id: 1, score: 10 } },
  };
  const snap = snapshotState(state);
  assert.equal(JSON.stringify(snap).includes("1234"), false);
  assert.deepEqual((snap["players"] as Record<string, Record<string, unknown>>)["p1"]!["areas"], ["A", "B"]);
  assert.equal("position" in (snap["players"] as Record<string, object>)["p1"]!, false);
  assert.ok("position" in (snapshotState(state, { include: ["players", "positions"] })["players"] as Record<string, object>)["p1"]!);
  assert.equal("devices" in snapshotState(state, { include: ["teams"] }), false);
  assert.equal("health" in ((snapshotState({ ...state, players: { p1: { ...state.players["p1"]!, health: 5 } } }, { ignore: ["players.*.health"] })["players"] as Record<string, object>)["p1"]!), false);

  const changed = snapshotState({ ...state, teams: { "1": { id: 1, score: 20 }, "2": { id: 2, score: 0 } } });
  assert.deepEqual(
    diffSnapshots(snap, changed).map((d) => d.path),
    ["teams.1.score", "teams.2"],
  );
  assert.deepEqual(diffSnapshots(snap, snapshotState(state)), []);
});
