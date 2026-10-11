import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScenarioError, YamlTestSchema, findYamlTest, generateScenario } from "@uefn-devtools/test";

const parse = (doc: unknown) => YamlTestSchema.parse(doc);
const locations = { A: [1200, 400, 0] as [number, number, number], Sky: [0, 0, 3000] as [number, number, number] };

test("player actions become ordered, confirmed device steps", () => {
  const g = generateScenario(
    parse({
      name: "Demo",
      setup: ["start_game", { spawn_player: { id: 1, team: 1 } }],
      steps: [
        { damage: { player: 1, amount: 25 } },
        { wait: "1s" },
        { enter: { player: 1, area: "A" } },
        { leave: { player: 1, area: "A" } },
        { eliminate: { player: 1 } },
        { wait_for: { event: "capture.completed" } },
      ],
    }),
    { id: "demo", locations, startDelayMs: 3000 },
  );
  assert.equal(g.className, "devtools_scenario_demo");
  assert.deepEqual(
    g.plan.map((s) => [s.index, s.action, s.player, s.arg]),
    [
      [0, "spawn_player", "player1", ""],
      [1, "damage_player", "player1", "25"],
      [2, "teleport", "player1", "A"],
      [3, "leave_area", "player1", "A"],
      [4, "eliminate_player", "player1", ""],
    ],
  );
  assert.match(g.verse, /Character\.Damage\(25\.0\)/);
  assert.match(g.verse, /Sleep\(1\.0\)/);
  assert.match(g.verse, /TeleportTo\[vector3\{X := 1200\.0, Y := 400\.0, Z := 0\.0\}/);
  assert.match(g.verse, /TeleportTo\[vector3\{X := 3200\.0, Y := 400\.0, Z := 0\.0\}/, "leave moves away from the area");
  assert.match(g.verse, /devtools_emitter\{SeqStart := 1000000\}/);
  assert.match(g.verse, /if \(Character\.GetHealth\(\) <= 0\.0\):\n\s+Emitter\.Emit\("player\.eliminated"/, "eliminate reports an observed elimination");
  assert.equal(g.verse.match(/player\.eliminated/g)?.length, 1, "only the eliminate step reports eliminations");
  assert.equal(g.warnings.length, 2, g.warnings.join("\n"));
});

test("scenario events carry the test id, the plan fingerprint and step arguments", () => {
  const doc = { name: "T", setup: ["start_game"], steps: [{ teleport: { player: 1, location: "A" } }] };
  const g = generateScenario(parse(doc), { id: "tagged", locations, startDelayMs: 0 });
  assert.match(g.fingerprint, /^[0-9a-f]{12}$/);
  assert.match(g.verse, new RegExp(`"scenario\\.started", array\\{DevToolsString\\("scenario", "tagged"\\), DevToolsString\\("plan", "${g.fingerprint}"\\)`));
  assert.match(g.verse, /"scenario\.step", array\{DevToolsString\("scenario", "tagged"\),.*DevToolsString\("arg", Arg\)/);
  assert.match(g.verse, /"scenario\.failed", array\{DevToolsString\("scenario", "tagged"\)/);
  assert.match(g.verse, /Step\(1, "teleport", "player1", "A"\)/);
  const moved = generateScenario(parse({ ...doc, steps: [{ teleport: { player: 1, location: "Sky" } }] }), { id: "tagged", locations, startDelayMs: 0 });
  assert.notEqual(moved.fingerprint, g.fingerprint, "a changed argument changes the fingerprint");
  const delayed = generateScenario(parse(doc), { id: "tagged", locations, startDelayMs: 3000 });
  assert.notEqual(delayed.fingerprint, g.fingerprint, "a changed start delay changes the fingerprint");
  const waited = (wait: string) =>
    generateScenario(parse({ ...doc, steps: [{ wait }, ...doc.steps] }), { id: "tagged", locations, startDelayMs: 0 }).fingerprint;
  assert.notEqual(waited("1s"), waited("2s"), "a changed wait changes the fingerprint");
});

test("teleport and enter spawn the player first, as the host fixtures do", () => {
  const g = generateScenario(
    parse({
      name: "Implicit",
      setup: ["start_game"],
      steps: [
        { teleport: { player: 1, location: "Sky" } },
        { enter: { player: 1, area: "A" } },
        { damage: { player: 2, amount: 5 } },
        { eliminate: { player: 1 } },
        { teleport: { player: 1, location: "A" } },
      ],
    }),
    { id: "implicit", locations, startDelayMs: 0 },
  );
  assert.deepEqual(
    g.plan.map((s) => [s.action, s.player]),
    [
      ["spawn_player", "player1"],
      ["teleport", "player1"],
      ["teleport", "player1"],
      ["damage_player", "player2"],
      ["eliminate_player", "player1"],
      ["spawn_player", "player1"],
      ["teleport", "player1"],
    ],
  );
});

test("each player is captured once and the character is read at every step", () => {
  const g = generateScenario(
    parse({
      name: "Bind",
      setup: ["start_game", { spawn_player: { id: 1 } }, { spawn_player: { id: 2 } }],
      steps: [{ damage: { player: 2, amount: 5 } }, { damage: { player: 1, amount: 5 } }],
    }),
    { id: "bind", locations, startDelayMs: 0 },
  );
  assert.match(g.verse, /var Players:\[\]player = array\{\}/);
  assert.equal(g.verse.match(/GetPlayers\(\)\[0\]/g)?.length, 1);
  assert.equal(g.verse.match(/GetPlayers\(\)\[1\]/g)?.length, 1);
  assert.equal(g.verse.match(/set Players \+= array\{Player\}/g)?.length, 2);
  assert.match(g.verse, /if \(Player := Players\[1\], Character := Player\.GetFortCharacter\[\]\):\n\s+Character\.Damage/);
});

test("a respawn after an elimination acts on the player's current character", () => {
  const g = generateScenario(
    parse({
      name: "Respawn",
      setup: ["start_game", { spawn_player: { id: 1 } }],
      steps: [{ eliminate: { player: 1 } }, { wait: "5s" }, { teleport: { player: 1, location: "Sky" } }],
    }),
    { id: "respawn", locations, startDelayMs: 0 },
  );
  // Every step after the first reads the character from the captured player,
  // never from a character cached before the elimination.
  assert.equal(g.verse.match(/Character := Player\.GetFortCharacter\[\]/g)?.length, g.plan.length);
  assert.doesNotMatch(g.verse, /fort_character = array/);
});

test("leave uses <area>.outside when configured", () => {
  const g = generateScenario(parse({ name: "L", setup: ["start_game"], steps: [{ leave: { player: 1, area: "A" } }] }), {
    id: "l",
    locations: { ...locations, "A.outside": [-500, 0, 0] },
    startDelayMs: 0,
  });
  assert.match(g.verse, /TeleportTo\[vector3\{X := -500\.0, Y := 0\.0, Z := 0\.0\}/);
  assert.doesNotMatch(g.verse, /X := 3200\.0/);
});

test("match boundaries around player actions are refused", () => {
  const opts = { id: "x", locations, startDelayMs: 0 };
  assert.throws(
    () => generateScenario(parse({ name: "x", setup: ["start_game"], steps: [{ damage: { player: 1, amount: 1 } }, "end_game", "start_game", { damage: { player: 1, amount: 1 } }] }), opts),
    (e) => e instanceof ScenarioError && /end_game after the first player action/.test(e.message),
  );
  assert.throws(
    () => generateScenario(parse({ name: "x", steps: [{ damage: { player: 1, amount: 1 } }] }), opts),
    (e) => e instanceof ScenarioError && /must start_game before its first player action/.test(e.message),
  );
  assert.throws(() => generateScenario(parse({ name: "x", setup: ["start_game", "end_game"], steps: [{ damage: { player: 1, amount: 1 } }] }), opts), /must start_game/);
});

test("unknown locations and device toggles are refused at generation time", () => {
  const opts = { id: "x", locations, startDelayMs: 0 };
  assert.throws(
    () => generateScenario(parse({ name: "x", setup: ["start_game"], steps: [{ teleport: { player: 1, location: "Nowhere" } }] }), opts),
    (e) => e instanceof ScenarioError && /scenario\.locations/.test(e.message),
  );
  assert.throws(() => generateScenario(parse({ name: "x", setup: ["start_game"], steps: [{ enable_device: { id: "D" } }] }), opts), ScenarioError);
  assert.throws(() => generateScenario(parse({ name: "x", steps: [{ wait: "1s" }] }), opts), /no player actions/);
});

test("names cannot break out of Verse string literals", () => {
  const g = generateScenario(parse({ name: 'Evil "{x}"\nname', setup: ["start_game"], steps: [{ spawn_player: { id: 'p"{1}' } }] }), {
    id: "evil",
    locations,
    startDelayMs: 0,
  });
  assert.match(g.verse, /DevToolsString\("player", "p\\"\\\{1\\\}"\)/);
  assert.doesNotMatch(g.verse.split("\n")[0]!, /\n/);
});

test("findYamlTest reports invalid YAML instead of skipping it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scenario-find-"));
  try {
    await writeFile(join(dir, "a.test.yaml"), "name: Good\nid: good\nsteps: []\n---\nname: Bad\nid: bad\nsteps: [{ nope: 1 }]\n");
    await assert.rejects(findYamlTest(dir, "bad"), (e) => e instanceof ScenarioError && /document 2\) is not a valid test/.test(e.message));
    await assert.rejects(findYamlTest(dir, "good"), /document 2\) is not a valid test/, "the runner rejects the whole file, so generation does too");
    await writeFile(join(dir, "a.test.yaml"), "name: Good\nid: good\nsteps: []\n");
    assert.equal((await findYamlTest(dir, "good"))?.test.name, "Good");
    assert.equal(await findYamlTest(dir, "missing"), undefined);
    await writeFile(join(dir, "b.test.yaml"), "name: [unclosed\n");
    await assert.rejects(findYamlTest(dir, "missing"), /could not be parsed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
