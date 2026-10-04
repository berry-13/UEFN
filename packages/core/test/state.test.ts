import assert from "node:assert/strict";
import { test } from "node:test";
import { EventStore, applyEvent, formatCausalTree, stateAt } from "@uefn-devtools/core";
import { emptyGameState, type RuntimeEvent } from "@uefn-devtools/protocol";

const events: RuntimeEvent[] = [
  { id: "e1", timestamp: 0, type: "game.started", payload: {} },
  { id: "e2", timestamp: 10, type: "player.spawned", payload: { player: "p1", team: 1, health: 100 } },
  { id: "e3", timestamp: 20, type: "player.entered_area", payload: { player: "p1", device: "A" } },
  { id: "e4", timestamp: 30, type: "capture.started", parentEventId: "e3", payload: { device: "A", team: 1 } },
  { id: "e5", timestamp: 40, type: "capture.completed", parentEventId: "e4", payload: { device: "A", team: 1 } },
  { id: "e6", timestamp: 40, type: "device.state_changed", payload: { device: "A", state: "Captured", owner: 1 } },
  { id: "e7", timestamp: 41, type: "score.changed", parentEventId: "e5", payload: { team: 1, previous: 0, current: 50 } },
];

test("reducer derives players, devices and teams", () => {
  const state = emptyGameState();
  for (const e of events) applyEvent(state, e);
  assert.equal(state.phase, "playing");
  assert.equal(state.players["p1"]?.team, 1);
  assert.deepEqual(state.players["p1"]?.areas, ["A"]);
  assert.equal(state.devices["A"]?.state, "Captured");
  assert.equal(state.devices["A"]?.owner, 1);
  assert.equal(state.teams["1"]?.score, 50);
});

test("stateAt replays to a point in time", () => {
  assert.equal(stateAt(events, 35).teams["1"], undefined);
  assert.equal(stateAt(events, 41).teams["1"]?.score, 50);
  assert.equal(stateAt(events, 35).devices["A"]?.state, undefined);
});

test("event store queries and causal trees", () => {
  const store = new EventStore();
  for (const e of events) store.append(e);
  assert.equal(store.query({ type: "score.changed", payload: { team: 1 } }).length, 1);
  assert.equal(store.query({ type: "score.changed", payload: { team: 2 } }).length, 0);
  assert.deepEqual(store.ancestry("e7").map((e) => e.id), ["e3", "e4", "e5", "e7"]);
  const tree = formatCausalTree(store.causalTree("e7")!);
  assert.match(tree, /^player\.entered_area/);
  assert.match(tree, /score\.changed \(team=1\)/);
  assert.deepEqual(store.countsByType(5), { "device.state_changed": 1, "score.changed": 1 });
});
