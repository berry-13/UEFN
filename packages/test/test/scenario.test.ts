import assert from "node:assert/strict";
import { test } from "node:test";
import { ScenarioError, YamlTestSchema, generateScenario } from "@uefn-devtools/test";

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
    g.plan.map((s) => [s.index, s.action, s.player]),
    [
      [0, "spawn_player", "player1"],
      [1, "damage_player", "player1"],
      [2, "teleport", "player1"],
      [3, "leave_area", "player1"],
      [4, "eliminate_player", "player1"],
    ],
  );
  assert.match(g.verse, /Character\.Damage\(25\.0\)/);
  assert.match(g.verse, /Sleep\(1\.0\)/);
  assert.match(g.verse, /TeleportTo\[vector3\{X := 1200\.0, Y := 400\.0, Z := 0\.0\}/);
  assert.match(g.verse, /TeleportTo\[vector3\{X := 3200\.0, Y := 400\.0, Z := 0\.0\}/, "leave moves away from the area");
  assert.match(g.verse, /devtools_emitter\{SeqStart := 1000000\}/);
  assert.equal(g.warnings.length, 2, g.warnings.join("\n"));
});

test("unknown locations and device toggles are refused at generation time", () => {
  assert.throws(
    () => generateScenario(parse({ name: "x", steps: [{ teleport: { player: 1, location: "Nowhere" } }] }), { id: "x", locations, startDelayMs: 0 }),
    (e) => e instanceof ScenarioError && /scenario\.locations/.test(e.message),
  );
  assert.throws(
    () => generateScenario(parse({ name: "x", steps: [{ enable_device: { id: "D" } }] }), { id: "x", locations, startDelayMs: 0 }),
    ScenarioError,
  );
  assert.throws(() => generateScenario(parse({ name: "x", steps: [{ wait: "1s" }] }), { id: "x", locations, startDelayMs: 0 }), /no player actions/);
});

test("names cannot break out of Verse string literals", () => {
  const g = generateScenario(parse({ name: 'Evil "{x}"\nname', steps: [{ spawn_player: { id: 'p"{1}' } }] }), { id: "evil", locations, startDelayMs: 0 });
  assert.match(g.verse, /DevToolsString\("player", "p\\"\\\{1\\\}"\)/);
  assert.doesNotMatch(g.verse.split("\n")[0]!, /\n/);
});
