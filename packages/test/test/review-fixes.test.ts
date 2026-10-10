import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Recording } from "@uefn-devtools/core";
import { EventTypes, emptyGameState, type RuntimeEvent, type RunSummary } from "@uefn-devtools/protocol";
import { generateYamlTest, loadTests, renderAnnotations, renderMarkdown, renderJunit, snapshotState } from "@uefn-devtools/test";

const ev = (type: string, timestamp: number, payload: Record<string, unknown> = {}): RuntimeEvent =>
  ({ id: `e${timestamp}${type}`, type, timestamp, payload }) as unknown as RuntimeEvent;

const rec = (events: RuntimeEvent[], extra: Partial<Recording> = {}): Recording => ({
  version: 1,
  name: "r",
  recordedAt: "2026-01-01T00:00:00Z",
  adapter: "simulated",
  startedAt: 0,
  endedAt: 10000,
  events,
  ...extra,
});

test("snapshot include positions implies players", () => {
  const state = emptyGameState();
  state.players["p1"] = { id: "p1", alive: true, areas: [], position: { x: 1, y: 2, z: 3 } } as never;
  const snap = snapshotState(state, { include: ["positions"] });
  assert.deepEqual((snap["players"] as Record<string, { position: unknown }>)["p1"]!.position, { x: 1, y: 2, z: 3 });
});

test("generator keeps a leave that only a teleport follows", () => {
  const events = [
    ev(EventTypes.PlayerSpawned, 0, { player: "p1" }),
    ev(EventTypes.PlayerExitedArea, 2000, { player: "p1", device: "A" }),
    ev(EventTypes.PlayerMoved, 2010, { player: "p1" }),
  ];
  assert.match(generateYamlTest(rec(events)).yaml, /leave/);
});

test("generator drops an exit implied by an elimination", () => {
  const events = [
    ev(EventTypes.PlayerSpawned, 0, { player: "p1" }),
    ev(EventTypes.PlayerExitedArea, 2000, { player: "p1", device: "A" }),
    ev(EventTypes.PlayerEliminated, 2010, { player: "p1" }),
  ];
  assert.doesNotMatch(generateYamlTest(rec(events)).yaml, /leave/);
});

test("generator seeds device enabled state from the recording baseline", () => {
  const events = [ev(EventTypes.GameStarted, 0), ev(EventTypes.DeviceStateChanged, 5000, { device: "D", enabled: true })];
  assert.match(generateYamlTest(rec(events, { baseline: { devices: { D: false } } })).yaml, /enable_device/);
  assert.doesNotMatch(generateYamlTest(rec(events, { baseline: { devices: { D: true } } })).yaml, /enable_device/);
});

const SUMMARY = {
  runId: "r",
  status: "failed",
  tests: [
    {
      id: "t",
      name: "Second",
      file: "x.test.yaml",
      status: "failed",
      attempts: [
        {
          iteration: 0,
          status: "failed",
          durationMs: 1,
          steps: [],
          assertions: [{ description: "snapshot 'a' matches", passed: false, message: "snapshot 'a' does not match (1 difference)", timestamp: 1 }],
          eventCounts: {},
        },
      ],
      passed: 0,
      failed: 1,
      reliability: 0,
      correlations: [],
    },
  ],
} as unknown as RunSummary;

test("reporters surface assertion.message", () => {
  assert.match(renderJunit(SUMMARY), /does not match/);
  assert.match(renderMarkdown(SUMMARY), /does not match/);
  assert.match(renderAnnotations(SUMMARY).join("\n"), /does not match/);
});

test("github annotation points at the matching document's name line", async () => {
  const root = await mkdtemp(join(tmpdir(), "uefn-gh-"));
  await writeFile(join(root, "x.test.yaml"), "name: First\nsteps: []\n---\nname: Second\nsteps: []\n");
  assert.match(renderAnnotations(SUMMARY, { root }).join("\n"), /line=4/);
  await writeFile(join(root, "x.test.yaml"), "name: Other\n");
  assert.doesNotMatch(renderAnnotations(SUMMARY, { root }).join("\n"), /line=/);
});

test("a test module that threw at load is re-imported once fixed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-disc-"));
  const file = join(dir, "a.test.ts");
  await writeFile(file, "throw new Error('boom');\n");
  const first = await loadTests([file]);
  assert.equal(first.errors.length, 1);
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(file, "export const ok = 1;\n");
  const second = await loadTests([file]);
  assert.deepEqual(second.errors, []);
});
