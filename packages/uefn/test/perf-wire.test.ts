import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "@uefn-devtools/protocol";
import { LogFileTransport, type Clock } from "@uefn-devtools/uefn";

const clock: Clock = { now: () => 42, sleep: async () => {}, toWallMs: (ms) => ms };

// Lines as devtools.verse ProfileSpan / PerfSample would print them: Verse
// interpolates floats with six decimals, and DevToolsParent adds parent:i.
const LINES = [
  "[2026.10.09-10.00.00:000][  1]LogVerse: devtools_log: [UEFN-DEVTOOLS]|1|E|11|capture.completed|device=A|team:i=1",
  "[2026.10.09-10.00.00:010][  2]LogVerse: devtools_log: [UEFN-DEVTOOLS]|1|E|12|perf.span|name=capture_handler|duration_ms:f=0.250000|parent:i=11",
  "[2026.10.09-10.00.00:020][  3]LogVerse: devtools_log: [UEFN-DEVTOOLS]|1|E|13|perf.sample|scope=world|frame_ms:f=16.700000|players:i=2|memory_mb:f=512.500000",
];

test("log transport parses perf.span and perf.sample wire lines from the Verse helpers", async () => {
  const transport = new LogFileTransport({ path: "/nonexistent", clock });
  for (const line of LINES) transport.ingest(line);
  await transport.stop();
  const events: RuntimeEvent[] = [];
  for await (const e of transport.receive()) events.push(e);
  assert.deepEqual(events[1], {
    id: "rt_12",
    timestamp: 42,
    type: "perf.span",
    parentEventId: "rt_11",
    payload: { name: "capture_handler", duration_ms: 0.25 },
  });
  assert.deepEqual(events[2], {
    id: "rt_13",
    timestamp: 42,
    type: "perf.sample",
    payload: { scope: "world", frame_ms: 16.7, players: 2, memory_mb: 512.5 },
  });
});
