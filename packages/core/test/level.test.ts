import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SNAPSHOT_SCRIPT,
  captureLevel,
  diffLevels,
  formatLevelDiff,
  levelDiffIsEmpty,
  normalizeCapture,
  parseLevelSnapshot,
  serializeLevelSnapshot,
  type EditorToolCaller,
} from "@uefn-devtools/core";

const L = "/Game/Island";
const row = (over: Record<string, unknown> = {}) => ({
  id: "G1",
  label: "Pump",
  class: "/Devices/Pump.Pump_C",
  path: `${L}:PersistentLevel.Pump_1`,
  folder: "None",
  dataLayers: [],
  transform: { location: { x: 100.004, y: -0.001, z: 5 }, rotation: { pitch: 0, yaw: 90.00001, roll: 0 }, scale: { x: 1, y: 1, z: 1 } },
  tags: [],
  bindings: [],
  ...over,
});

test("a capture becomes a sorted, rounded snapshot without empty fields", () => {
  const { snapshot, errors } = normalizeCapture({
    level: L,
    actors: [row({ id: "G2", label: "Zone", tags: ["b", "a"], folder: "Gameplay", settings: "" }), row(), row({ id: "G0", label: "Pump" })],
    errors: ["Zone tags: boom"],
  });
  assert.deepEqual(errors, ["Zone tags: boom"]);
  assert.deepEqual(
    snapshot.actors.map((a) => a.id),
    ["G0", "G1", "G2"],
    "sorted by label, then id",
  );
  const pump = snapshot.actors[1]!;
  assert.deepEqual(pump.location, [100, 0, 5], "float noise and -0 are rounded away");
  assert.deepEqual(pump.rotation, [0, 90, 0]);
  assert.equal(Object.hasOwn(pump, "folder"), false, "the 'None' folder is left out");
  assert.equal(Object.hasOwn(pump, "tags"), false);
  assert.equal(Object.hasOwn(pump, "bindings"), false);
  const zone = snapshot.actors[2]!;
  assert.deepEqual(zone.tags, ["a", "b"]);
  assert.equal(zone.folder, "Gameplay");
  assert.equal(Object.hasOwn(zone, "settings"), false);
});

test("JSON settings and bindings are kept parsed", () => {
  const { snapshot } = normalizeCapture({ level: L, actors: [row({ settings: '{"Speed":{"value":5}}', bindings: [{ event: "On Empty", target: "X" }] })] });
  assert.deepEqual(snapshot.actors[0]!.settings, { Speed: { value: 5 } });
  assert.deepEqual(snapshot.actors[0]!.bindings, [{ event: "On Empty", target: "X" }]);
});

test("the same level always serialises to the same bytes, and parses back", () => {
  const a = serializeLevelSnapshot(normalizeCapture({ level: L, actors: [row(), row({ id: "G2", label: "A" })] }).snapshot);
  const b = serializeLevelSnapshot(normalizeCapture({ level: L, actors: [row({ id: "G2", label: "A" }), row()] }).snapshot);
  assert.equal(a, b);
  assert.deepEqual(parseLevelSnapshot(a).actors.length, 2);
  assert.throws(() => parseLevelSnapshot("{}", "x.json"), /x\.json is not a version 1 level snapshot/);
  assert.throws(() => parseLevelSnapshot("nope", "x.json"), /x\.json is not JSON/);
});

test("diff matches actors by guid: moved and renamed are changes", () => {
  const before = normalizeCapture({ level: L, actors: [row(), row({ id: "G2", label: "Old" })] }).snapshot;
  const after = normalizeCapture({
    level: L,
    actors: [
      row({ label: "Pump Renamed", transform: { location: { x: 300, y: 0, z: 5 }, rotation: { pitch: 0, yaw: 90, roll: 0 }, scale: { x: 1, y: 1, z: 1 } } }),
      row({ id: "G3", label: "New" }),
    ],
  }).snapshot;
  const diff = diffLevels(before, after);
  assert.deepEqual(diff.added.map((a) => a.id), ["G3"]);
  assert.deepEqual(diff.removed.map((a) => a.id), ["G2"]);
  assert.deepEqual(diff.changed, [{ id: "G1", label: "Pump Renamed", fields: { label: ["Pump", "Pump Renamed"], location: [[100, 0, 5], [300, 0, 5]] } }]);
  const text = formatLevelDiff(diff);
  assert.match(text, /^\+ New \(Pump_C\) at \(100, 0, 5\)$/m);
  assert.match(text, /^- Old \(Pump_C\)/m);
  assert.match(text, /^    location: \(100, 0, 5\) -> \(300, 0, 5\)$/m);
  assert.match(text, /1 added, 1 removed, 1 changed$/);
  assert.equal(levelDiffIsEmpty(diff), false);
  assert.equal(levelDiffIsEmpty(diffLevels(before, before)), true);
  assert.deepEqual(diffLevels(before, { ...before, level: "/Game/Other" }).levels, [L, "/Game/Other"]);
});

test("captureLevel runs the batch script and reads UEFN's string returnValue", async () => {
  const calls: unknown[] = [];
  const caller: EditorToolCaller = {
    async callEditorTool(toolset, tool, args, options) {
      calls.push({ toolset, tool, script: args["script"], timeoutMs: options?.timeoutMs });
      return { isError: false, text: "", json: { returnValue: JSON.stringify({ level: L, actors: [row()], errors: [] }) } };
    },
  };
  const capture = await captureLevel(caller);
  assert.equal(capture.snapshot.actors.length, 1);
  assert.equal(capture.snapshot.level, L);
  assert.deepEqual(calls, [{ toolset: "editor_toolset.toolsets.programmatic.ProgrammaticToolset", tool: "execute_tool_script", script: SNAPSHOT_SCRIPT, timeoutMs: 600_000 }]);
  const failing: EditorToolCaller = { callEditorTool: async () => ({ isError: true, text: "Python is disabled" }) };
  await assert.rejects(captureLevel(failing), /reading the level failed: Python is disabled/);
});
