import assert from "node:assert/strict";
import { test } from "node:test";
import { DevToolsConfig, encodeWireValue, parseDuration, parseWireLine, wireRecordToEvent } from "@uefn-devtools/protocol";

test("parses an event line embedded in a UE log line", () => {
  const line =
    "[2026.10.04-13.24.11:123][456]LogVerse: [UEFN-DEVTOOLS]|1|E|7|score.changed|team:i=1|previous:i=0|current:i=50|src=device:CapturePointA|trace=tr_1|parent=6";
  const record = parseWireLine(line);
  assert.ok(record);
  assert.equal(record.kind, "E");
  assert.equal(record.seq, 7);
  const event = wireRecordToEvent(record, 1000);
  assert.deepEqual(event, {
    id: "rt_7",
    timestamp: 1000,
    type: "score.changed",
    payload: { team: 1, previous: 0, current: 50 },
    source: { type: "device", id: "CapturePointA" },
    traceId: "tr_1",
    parentEventId: "rt_6",
  });
});

test("probe and hello records map to canonical events", () => {
  const probe = wireRecordToEvent(parseWireLine("[UEFN-DEVTOOLS]|1|P|3|team.1.score|v:i=50")!, 5);
  assert.equal(probe.type, "probe.updated");
  assert.deepEqual(probe.payload, { probe: "team.1.score", value: 50 });
  const hello = wireRecordToEvent(parseWireLine("[UEFN-DEVTOOLS]|1|H|1|0.1.0")!, 0);
  assert.equal(hello.type, "session.ready");
});

test("typed fields and escaping round-trip", () => {
  const name = encodeWireValue("a|b=c%d\ne");
  const r = parseWireLine(`[UEFN-DEVTOOLS]|1|E|1|x|name=${name}|ok:b=true|f:f=1.5|pos:v=1,2,3`)!;
  assert.deepEqual(r.fields, { name: "a|b=c%d\ne", ok: true, f: 1.5, pos: [1, 2, 3] });
});

test("ignores unrelated lines and rejects malformed DevTools lines", () => {
  assert.equal(parseWireLine("[2026.10.04][1]LogVerse: hello"), undefined);
  assert.throws(() => parseWireLine("[UEFN-DEVTOOLS]|2|E|1|x"), /version/);
  assert.throws(() => parseWireLine("[UEFN-DEVTOOLS]|1|E|1|x|n:i=abc"), /invalid int/);
  assert.throws(() => parseWireLine("[UEFN-DEVTOOLS]|1|Q|1|x"), /kind/);
});

test("config defaults and durations", () => {
  const config = DevToolsConfig.parse({});
  assert.equal(config.adapter, "simulated");
  assert.equal(config.paths.tests, "./Tests");
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("250ms"), 250);
  assert.equal(parseDuration(42), 42);
  assert.throws(() => parseDuration("soon"));
});
