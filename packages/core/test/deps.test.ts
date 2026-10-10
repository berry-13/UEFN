import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  buildDepsGraph,
  exportDot,
  exportMermaid,
  impactOf,
  loadConfig,
  scanTsTests,
  scanVerse,
  scanYamlTests,
  stripVerse,
} from "@uefn-devtools/core";

const EXAMPLE = resolve(import.meta.dirname, "../../../examples/capture-point");

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "uefn-devtools-deps-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

test("scanner ignores comments and string contents but keeps strings it needs", () => {
  const src = [
    "using { /Fortnite.com/Devices }",
    "# fake := class(creative_device)",
    "<# block",
    "   hidden := class(creative_device)",
    "   <# nested #> still hidden := class()",
    "#>",
    'real<public> := class<final>(creative_device, helper):',
    '    # DevTools.Emit("commented.out", array{})',
    '    Note:string = "ghost := class(x) # not a comment"',
    "    @editable",
    "    Door:door_device = door_device{}",
    "    @editable",
    "    Reward:int = 5",
    "    Run():void =",
    '        DevTools.Emit("door.opened", array{DevToolsSource("device", "Door")})',
    '        DevTools.ProbeInt("door.count", 1)',
    "",
  ].join("\n");
  const stripped = stripVerse(src);
  assert.equal(stripped.code.length, src.length);
  assert.ok(!stripped.code.includes("hidden"));

  const scan = scanVerse("x.verse", src);
  assert.deepEqual(scan.decls.map((d) => d.name), ["real"]);
  assert.deepEqual(scan.decls[0]!.parents, ["creative_device", "helper"]);
  assert.equal(scan.decls[0]!.line, 7);
  assert.deepEqual(scan.imports.map((i) => i.path), ["/Fortnite.com/Devices"]);
  assert.deepEqual(scan.editables.map((e) => [e.name, e.type, e.owner]), [
    ["Door", "door_device", "real"],
    ["Reward", "int", "real"],
  ]);
  assert.deepEqual(scan.emits.map((e) => [e.name, e.probe, e.line]), [["door.opened", false, 15], ["door.count", true, 16]]);
  assert.deepEqual(scan.deviceRefs.map((d) => d.id), ["Door"]);
});

test("modules nest their classes", () => {
  const scan = scanVerse("m.verse", "game<public> := module:\n    inner := class:\n        X:int = 1\n    other := class:\n        Y:int = 2\n");
  assert.deepEqual(scan.decls.map((d) => [d.name, d.kind, d.parent]), [
    ["game", "module", undefined],
    ["inner", "class", "game"],
    ["other", "class", "game"],
  ]);
});

test("test scanners find device and event references", () => {
  const ts = scanTsTests(
    "t.test.ts",
    [
      "// game.device('Commented')",
      'test("one", async ({ game }) => {',
      '  await game.player("p").enter("A");',
      '  await expect(game.device("B")).toHaveState("x");',
      '  await expect(game.events).toHaveOccurred("CaptureCompleted");',
      "});",
      'test("two", async ({ game }) => { game.event("score.changed"); game.probe("p.1"); });',
    ].join("\n"),
  );
  assert.deepEqual(ts.map((t) => t.id), ["one", "two"]);
  assert.deepEqual(ts[0]!.devices.map((d) => [d.id, d.role]), [["A", "area"], ["B", "device"]]);
  assert.deepEqual(ts[0]!.events.map((e) => e.id), ["capture.completed"]);
  assert.deepEqual(ts[1]!.events.map((e) => e.id), ["score.changed"]);
  assert.deepEqual(ts[1]!.probes.map((e) => e.id), ["p.1"]);

  const yaml = scanYamlTests(
    "t.test.yaml",
    "name: Y\nsteps:\n  - teleport: { player: p, location: A }\n  - wait_for: { event: CaptureCompleted }\nassert:\n  - device: { id: B }\n  - event: { type: ScoreChanged }\n  - probe: { id: q, value: 1 }\n",
  );
  assert.equal(yaml[0]!.id, "y");
  assert.deepEqual(yaml[0]!.devices.map((d) => d.id), ["A", "B"]);
  assert.deepEqual(yaml[0]!.events.map((e) => e.id), ["capture.completed", "score.changed"]);
  assert.deepEqual(yaml[0]!.probes.map((e) => e.id), ["q"]);
});

test("example project graph links the manager to its tests", async () => {
  const graph = await buildDepsGraph(await loadConfig(EXAMPLE));
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const id of ["file:Verse/capture_manager.verse", "class:capture_manager", "device:CapturePointA", "event:capture.completed", "probe:capture_manager.awarded_score"]) {
    assert.ok(ids.has(id), id);
  }
  assert.ok(graph.edges.some((e) => e.from === "class:capture_manager" && e.to === "event:capture.completed" && e.kind === "emits"));
  assert.ok(graph.edges.some((e) => e.from === "class:capture_manager" && e.to === "class:creative_device" && e.kind === "extends"));

  const impact = impactOf(graph, "Verse/capture_manager.verse");
  assert.deepEqual(
    impact.tests.map((t) => t.label).sort(),
    ["capture-completes-within-the-configured-time", "capture-point-a", "capturing-a-awards-50-points", "contested-point-does-not-award-score"],
  );
  assert.equal(impactOf(graph, "capture_manager").tests.length, 4);
  assert.equal(impactOf(graph, "no_such_file.verse").seeds.length, 0);
  assert.equal(impactOf(graph, resolve(EXAMPLE, "Verse/capture_manager.verse")).tests.length, 4);
});

test("impact is transitive through class references and module imports", async () => {
  const dir = await project({
    "uefn-devtools.config.yaml": "",
    "Verse/emitter.verse": 'devtools_emitter<public> := class:\n    Emit<public>(T:string):void = {}\n',
    "Verse/mod.verse": "scoring<public> := module:\n    helper<public> := class:\n        V:int = 1\n",
    "Verse/door.verse":
      "using { scoring }\n" +
      "door_logic := class(creative_device):\n" +
      "    DevTools:devtools_emitter = devtools_emitter{}\n" +
      "    @editable\n    Door:door_device = door_device{}\n" +
      '    Open():void =\n        DevTools.Emit("door.opened", array{})\n',
    "Verse/unrelated.verse": 'lonely := class(creative_device):\n    Run():void =\n        DevTools.Emit("lonely.event", array{})\n',
    "Tests/door.test.yaml": "name: Door opens\nsteps:\n  - wait_for: { event: door.opened }\n",
    "Tests/lonely.test.yaml": "name: Lonely\nsteps:\n  - wait_for: { event: lonely.event }\n",
    "Tests/door-device.test.yaml": "name: Door device\nassert:\n  - device: { id: Door, enabled: true }\n",
  });
  const graph = await buildDepsGraph(await loadConfig(dir));

  const viaEmitter = impactOf(graph, "Verse/emitter.verse");
  assert.deepEqual(viaEmitter.tests.map((t) => t.label).sort(), ["door-device", "door-opens"]);

  const viaModule = impactOf(graph, "Verse/mod.verse");
  assert.deepEqual(viaModule.tests.map((t) => t.label).sort(), ["door-device", "door-opens"]);

  const unrelated = impactOf(graph, "Verse/unrelated.verse");
  assert.deepEqual(unrelated.tests.map((t) => t.label), ["lonely"]);

  const testFile = impactOf(graph, "Tests/lonely.test.yaml");
  assert.deepEqual(testFile.tests.map((t) => t.label), ["lonely"]);
});

test("exporters produce DOT and Mermaid", async () => {
  const graph = await buildDepsGraph(await loadConfig(EXAMPLE));
  const dot = exportDot(graph);
  assert.match(dot, /^digraph uefn_deps \{/);
  assert.match(dot, /"class:capture_manager" -> "event:capture\.completed" \[label="emits"\]/);
  const mermaid = exportMermaid(graph);
  assert.match(mermaid, /^flowchart LR/);
  assert.match(mermaid, /-->\|emits\|/);
  assert.ok(!mermaid.includes('""'));
});

test("emitted PascalCase events normalize to the id tests use", async () => {
  const dir = await project({
    "uefn-devtools.config.yaml": "",
    "Verse/a.verse": 'a := class(creative_device):\n    Run():void =\n        DevTools.Emit("CaptureCompleted", array{})\n',
    "Tests/a.test.yaml": "name: Cap\nsteps:\n  - wait_for: { event: capture.completed }\n",
  });
  const graph = await buildDepsGraph(await loadConfig(dir));
  assert.ok(graph.nodes.some((n) => n.id === "event:capture.completed"));
  assert.deepEqual(impactOf(graph, "Verse/a.verse").tests.map((t) => t.label), ["cap"]);
});
