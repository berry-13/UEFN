import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProfile, distribution, formatProfile, percentile, toChromeTrace, type StageMark } from "@uefn-devtools/core";
import type { RuntimeEvent } from "@uefn-devtools/protocol";

const span = (id: string, t: number, name: string, d: number, parent?: string): RuntimeEvent => ({
  id, timestamp: t, type: "perf.span", ...(parent ? { parentEventId: parent } : {}), payload: { name, duration_ms: d },
});
const sample = (id: string, t: number, frame: number, players: number): RuntimeEvent => ({
  id, timestamp: t, type: "perf.sample", payload: { scope: "world", frame_ms: frame, players },
});

const events: RuntimeEvent[] = [
  { id: "e1", timestamp: 0, type: "player.entered_area", payload: { player: "p1", device: "A" } },
  { id: "e2", timestamp: 100, type: "capture.started", parentEventId: "e1", payload: { device: "A" } },
  sample("s1", 500, 16, 1),
  { id: "e3", timestamp: 1100, type: "capture.completed", parentEventId: "e2", payload: { device: "A" } },
  { id: "e4", timestamp: 1100, type: "score.changed", parentEventId: "e3", payload: { team: 1 } },
  span("p1", 1100, "capture_handler", 2, "e3"),
  { id: "e5", timestamp: 1200, type: "player.entered_area", payload: { player: "p2", device: "B" } },
  { id: "e6", timestamp: 1500, type: "capture.started", parentEventId: "e5", payload: { device: "B" } },
  sample("s2", 1500, 20, 2),
  { id: "e7", timestamp: 3500, type: "capture.completed", parentEventId: "e6", payload: { device: "B" } },
  { id: "e8", timestamp: 3510, type: "score.changed", parentEventId: "e7", payload: { team: 2 } },
  span("p2", 3510, "capture_handler", 4, "e7"),
  span("p3", 3600, "score_handler", 1),
  sample("s3", 4000, 30, 2),
];

test("percentiles use nearest rank", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 95), 10);
  assert.equal(percentile(values, 10), 1);
  assert.equal(percentile([], 50), 0);
  assert.deepEqual(distribution([4, 1, 3, 2]), { count: 4, min: 1, mean: 2.5, p50: 2, p95: 4, max: 4 });
});

test("profile aggregates throughput, spans, samples and causal latency", () => {
  const p = buildProfile(events);
  assert.deepEqual(p.session, { startMs: 0, endMs: 4000, durationMs: 4000, events: 14 });
  assert.equal(p.throughput.eventsPerSecond, 3.5);
  assert.deepEqual(p.hotEventTypes[0], { type: "perf.sample", count: 3, perSecond: 0.75, share: 0.214 });

  assert.deepEqual(p.spans, [
    { name: "capture_handler", count: 2, totalMs: 6, meanMs: 3, p50Ms: 2, p95Ms: 4, maxMs: 4 },
    { name: "score_handler", count: 1, totalMs: 1, meanMs: 1, p50Ms: 1, p95Ms: 1, maxMs: 1 },
  ]);
  assert.deepEqual(
    p.samples.map((s) => [s.metric, s.min, s.mean, s.p95, s.max]),
    [
      ["world.frame_ms", 16, 22, 30, 30],
      ["world.players", 1, 1.667, 2, 2],
    ],
  );

  // perf.span children are excluded; each gameplay edge aggregates both captures.
  assert.deepEqual(
    p.causalLatency.map((e) => [`${e.parentType} -> ${e.childType}`, e.count, e.meanMs, e.p50Ms, e.maxMs]),
    [
      ["capture.started -> capture.completed", 2, 1500, 1000, 2000],
      ["player.entered_area -> capture.started", 2, 200, 100, 300],
      ["capture.completed -> score.changed", 2, 5, 0, 10],
    ],
  );
});

test("stage timings per test and run", () => {
  const stages: StageMark[] = [
    { stage: "BUILDING", at: 0 },
    { stage: "STARTING_SESSION", at: 10 },
    { stage: "WAITING_FOR_RUNTIME", at: 30 },
    { stage: "INITIALIZING", test: "a", iteration: 0, at: 100 },
    { stage: "RUNNING", test: "a", iteration: 0, at: 105 },
    { stage: "ASSERTING", test: "a", iteration: 0, at: 905 },
    { stage: "CLEANUP", test: "a", iteration: 0, at: 1005 },
    { stage: "PASSED", at: 1010 },
  ];
  const p = buildProfile(events, { stages });
  assert.equal(p.stages!.totals["WAITING_FOR_RUNTIME"], 70);
  assert.deepEqual(p.stages!.perTest, [
    { test: "a", iteration: 0, stages: { INITIALIZING: 5, RUNNING: 800, ASSERTING: 100, CLEANUP: 5 } },
  ]);
  assert.match(formatProfile(p), /capture_handler\s+2\s+6\.000/);
  assert.match(formatProfile(p), /RUNNING\s+800\.000/);
});

test("chrome trace uses X for spans and stages, C for samples", () => {
  const trace = toChromeTrace(events, { stages: [{ stage: "RUNNING", test: "a", at: 0 }, { stage: "PASSED", at: 4000 }] });
  const spans = trace.traceEvents.filter((e) => e.cat === "span");
  assert.deepEqual(
    spans.map((e) => [e.ph, e.name, e.ts, e.dur]),
    [
      ["X", "capture_handler", 1_098_000, 2000],
      ["X", "capture_handler", 3_506_000, 4000],
      ["X", "score_handler", 3_599_000, 1000],
    ],
  );
  const counters = trace.traceEvents.filter((e) => e.ph === "C");
  assert.equal(counters.length, 6);
  assert.deepEqual(counters[0], { name: "world.frame_ms", ph: "C", cat: "sample", ts: 500_000, pid: 1, tid: 0, args: { value: 16 } });
  const stage = trace.traceEvents.find((e) => e.cat === "stage")!;
  assert.deepEqual([stage.ph, stage.ts, stage.dur], ["X", 0, 4_000_000]);
  assert.equal(trace.traceEvents.filter((e) => e.ph === "i").length, 8);
  assert.ok(trace.traceEvents.every((e) => Number.isInteger(e.ts) && e.pid === 1));
  JSON.parse(JSON.stringify(trace));
});
