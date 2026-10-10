import assert from "node:assert/strict";
import { test } from "node:test";
import { SimulatedConfig, type RuntimeEvent } from "@uefn-devtools/protocol";
import { SimulatedAdapter, SimulatedWorld } from "@uefn-devtools/uefn";

function run(seed: number, profiling?: { enabled: boolean; sample_every_ticks: number }): RuntimeEvent[] {
  const config = SimulatedConfig.parse({
    seed,
    tick_ms: 100,
    devices: [{ id: "A", capture_time_ms: 1000, score: 50 }],
    ...(profiling ? { profiling } : {}),
  });
  const events: RuntimeEvent[] = [];
  const world = new SimulatedWorld(config, (e) => {
    const id = e.id ?? `sim_${events.length + 1}`;
    events.push({ ...e, id, timestamp: events.length });
    return id;
  });
  world.handle({ type: "start_game" });
  world.handle({ type: "spawn_player", player: "p1", team: 1 });
  world.handle({ type: "teleport", player: "p1", location: "A" });
  for (let i = 0; i < 30; i++) world.tick(100);
  return events;
}

test("simulator emits perf events deterministically for a seed", () => {
  const first = run(7);
  assert.deepEqual(run(7), first);
  assert.notDeepEqual(run(8).filter((e) => e.type === "perf.sample"), first.filter((e) => e.type === "perf.sample"));

  const samples = first.filter((e) => e.type === "perf.sample");
  assert.equal(samples.length, 3, "default: one sample every 10 ticks");
  for (const s of samples) {
    assert.equal(s.payload["scope"], "world");
    assert.equal(s.payload["players"], 1);
    assert.equal(s.payload["devices"], 1);
    assert.equal(s.payload["entities"], 2);
    for (const k of ["frame_ms", "tick_ms", "memory_mb"]) assert.equal(typeof s.payload[k], "number", k);
  }

  const spans = first.filter((e) => e.type === "perf.span");
  assert.deepEqual(spans.map((s) => s.payload["name"]), ["score_handler", "capture_handler"]);
  const byId = new Map(first.map((e) => [e.id, e]));
  assert.equal(byId.get(spans[0]!.parentEventId!)!.type, "score.changed");
  assert.equal(byId.get(spans[1]!.parentEventId!)!.type, "capture.completed");
  for (const s of spans) assert.ok((s.payload["duration_ms"] as number) > 0);
});

test("profiling can be disabled and does not change gameplay events", () => {
  const off = run(7, { enabled: false, sample_every_ticks: 10 });
  assert.equal(off.filter((e) => e.type.startsWith("perf.")).length, 0);
  const gameplay = (events: RuntimeEvent[]) =>
    events.filter((e) => !e.type.startsWith("perf.")).map((e) => [e.type, e.payload]);
  assert.deepEqual(gameplay(off), gameplay(run(7)));
});

test("a very fast simulated clock does not starve the event loop", async () => {
  const config = SimulatedConfig.parse({ seed: 1, tick_ms: 1, time_scale: 5000, boot_ms: 1, devices: [{ id: "A", capture_time_ms: 1000, score: 50 }] });
  const adapter = new SimulatedAdapter({ config, verseDir: "." });
  await adapter.startSession();
  const transport = adapter.transport();
  await transport.start();
  let beats = 0;
  const heartbeat = setInterval(() => beats++, 20);
  const started = performance.now();
  await new Promise((r) => setTimeout(r, 1000));
  const stopping = performance.now();
  await adapter.stopSession();
  clearInterval(heartbeat);
  assert.ok(beats >= 10, `event loop heartbeats: ${beats}`);
  assert.ok(performance.now() - stopping < 1000, "session stops promptly");
  assert.ok(stopping - started < 3000);
});

test("no perf.sample is emitted while no match is playing", () => {
  const config = SimulatedConfig.parse({ seed: 1, tick_ms: 100, devices: [{ id: "A" }], profiling: { enabled: true, sample_every_ticks: 1 } });
  const events: RuntimeEvent[] = [];
  const world = new SimulatedWorld(config, (e) => {
    events.push({ ...e, id: `e${events.length}`, timestamp: events.length });
    return `e${events.length}`;
  });
  for (let i = 0; i < 10; i++) world.tick(100);
  assert.equal(events.filter((e) => e.type === "perf.sample").length, 0);
  world.handle({ type: "start_game" });
  world.tick(100);
  assert.ok(events.some((e) => e.type === "perf.sample"));
});
