import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeEvent } from "@uefn-devtools/protocol";
import { LogFileTransport, RealClock, type Clock } from "@uefn-devtools/uefn";

test("tails only new log lines and parses DevTools + LogVerse lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-log-"));
  const path = join(dir, "UnrealEditorFortnite.log");
  await writeFile(path, "[2026.10.04-13.00.00:000][  0]LogVerse: [UEFN-DEVTOOLS]|1|H|0|stale\n");
  const transport = new LogFileTransport({ path, clock: new RealClock(), pollMs: 10 });
  await transport.start();
  await appendFile(
    path,
    [
      "[2026.10.04-13.24.11:123][456]LogVerse: devtools_log: [UEFN-DEVTOOLS]|1|H|0|0.1.0",
      "[2026.10.04-13.24.11:200][457]LogVerse: Warning: something odd",
      "[2026.10.04-13.24.11:300][458]LogNet: ignored category",
      "[2026.10.04-13.24.12:000][460]LogVerse: [UEFN-DEVTOOLS]|1|P|1|team.1.sc",
    ].join("\n"),
  );
  // Second half of a line arrives in a later write.
  await new Promise((r) => setTimeout(r, 50));
  await appendFile(path, "ore|v:i=50\n[x][1]LogVerse: [UEFN-DEVTOOLS]|1|E|2|bad|n:i=nope\n");
  await new Promise((r) => setTimeout(r, 50));
  await transport.stop();

  const events: RuntimeEvent[] = [];
  for await (const e of transport.receive()) events.push(e);
  assert.deepEqual(
    events.map((e) => e.type),
    ["session.ready", "log", "probe.updated", "log"],
  );
  assert.equal(events[0]!.payload["runtimeVersion"], "0.1.0");
  assert.equal(events[1]!.payload["level"], "warning");
  assert.deepEqual(events[2]!.payload, { probe: "team.1.score", value: 50 });
  assert.match(String(events[3]!.payload["message"]), /malformed/);
  const result = await transport.command({ type: "start_game" });
  assert.equal(result.unsupported, true);
});

// Lines copied verbatim from a real UEFN 41.10 editor log (UnrealEditorFortnite.log).
const REAL = {
  print: "[2026.07.05-20.03.53:924][514]LogVerse: : CarUpgradeManager: Ready.",
  channel: "[2026.07.05-20.59.28:828][949]LogVerse: Marketplace: Purchase successful",
  warning: "[2026.07.05-20.03.55:816][740]LogVerse: Warning: Devices_move_to_debug_log: MoveTo error: The object being moved is no longer valid",
  warmup: "[2026.07.05-20.03.53:924][514]LogValkyrieBeacon: [3905] (ValkyrieBeaconClient_0) MinigameStateChanged: EFortMinigameState::Warmup",
  inProgress: "[2026.07.05-20.03.53:924][514]LogValkyrieBeacon: [3905] (ValkyrieBeaconClient_0) MinigameStateChanged: EFortMinigameState::InProgress",
  postGameEnd: "[2026.07.05-20.12.47:165][ 25]LogValkyrieBeacon: [3905] (ValkyrieBeaconClient_0) MinigameStateChanged: EFortMinigameState::PostGameEnd",
};

test("real UEFN log shapes: Verse channels, BOM and match lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-log-"));
  const path = join(dir, "UnrealEditorFortnite.log");
  await writeFile(path, "");
  const transport = new LogFileTransport({ path, clock: new RealClock(), pollMs: 10 });
  await transport.start();
  const lines = ["﻿" + REAL.print, REAL.channel, REAL.warning, REAL.warmup, REAL.inProgress, REAL.inProgress, REAL.postGameEnd];
  await appendFile(path, lines.join("\r\n") + "\r\n");
  // A multi-byte character split across two writes must survive.
  const accented = Buffer.from("[2026.07.05-20.59.28:828][949]LogVerse: Shop: Café open\r\n", "utf8");
  const cut = accented.indexOf(0xc3) + 1;
  await new Promise((r) => setTimeout(r, 40));
  await appendFile(path, accented.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 40));
  await appendFile(path, accented.subarray(cut));
  await new Promise((r) => setTimeout(r, 40));
  await transport.stop();

  const events: RuntimeEvent[] = [];
  for await (const e of transport.receive()) events.push(e);
  assert.deepEqual(
    events.map((e) => e.type),
    ["log", "log", "log", "game.started", "game.ended", "log"],
  );
  assert.deepEqual(events[0]!.payload, { category: "LogVerse", level: "log", message: "CarUpgradeManager: Ready." });
  assert.deepEqual(events[1]!.payload, { category: "LogVerse", level: "log", channel: "Marketplace", message: "Purchase successful" });
  assert.equal(events[2]!.payload["level"], "warning");
  assert.equal(events[2]!.payload["channel"], "Devices_move_to_debug_log");
  assert.equal(events[5]!.payload["message"], "Café open");
});

/** A clock that stands still, so timestamps are exact. */
const fixedClock = (now = 10_000): Clock => ({ now: () => now, sleep: async () => {}, toWallMs: (ms) => ms });

async function drain(transport: LogFileTransport): Promise<RuntimeEvent[]> {
  await transport.stop();
  const events: RuntimeEvent[] = [];
  for await (const e of transport.receive()) events.push(e);
  return events;
}

test("only LogValkyrieBeacon reports match state; only LogVerse has channels", async () => {
  const transport = new LogFileTransport({ path: "/nonexistent/uefn.log", clock: fixedClock(), categories: ["LogVerse", "LogNet"] });
  transport.ingest("[2026.10.09-10.00.00:000][  1]LogVerse: : MinigameStateChanged: EFortMinigameState::InProgress");
  transport.ingest("[2026.10.09-10.00.00:000][  1]LogNet: Connection: closed");
  transport.ingest("[2026.10.09-10.00.00:000][  1]LogVerse: DevTools-devtools_log: hi");
  const events = await drain(transport);
  assert.deepEqual(events.map((e) => e.type), ["log", "log", "log"]);
  assert.equal(events[0]!.payload["message"], "MinigameStateChanged: EFortMinigameState::InProgress");
  assert.deepEqual(events[1]!.payload, { category: "LogNet", level: "log", message: "Connection: closed" });
  assert.equal(events[2]!.payload["channel"], "DevTools-devtools_log");
});

test("runtime event ids stay unique when the device restarts and its sequence repeats", async () => {
  const transport = new LogFileTransport({ path: "/nonexistent/uefn.log", clock: fixedClock() });
  const wire = (body: string) => `[2026.10.09-10.00.00:000][  1]LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|${body}`;
  for (const body of ["H|0|0.1.0", "P|1|poc.counter|v:i=1", "H|0|0.1.0", "P|1|poc.counter|v:i=1", "E|2|x|parent=1"]) transport.ingest(wire(body));
  const events = await drain(transport);
  assert.deepEqual(events.map((e) => e.id), ["rt_0", "rt_1", "rt2_0", "rt2_1", "rt2_2"]);
  assert.equal(events[4]!.parentEventId, "rt2_1");
});

test("events read together keep the spacing of their UE log timestamps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-log-"));
  const path = join(dir, "UnrealEditorFortnite.log");
  await writeFile(path, "");
  const transport = new LogFileTransport({ path, clock: fixedClock(), pollMs: 10 });
  await transport.start();
  await appendFile(
    path,
    [
      "[2026.10.09-10.00.00:000][  1]LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|H|0|0.1.0",
      "[2026.10.09-10.00.00:750][  9]LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|P|1|poc.counter|v:i=1",
      "",
    ].join("\n"),
  );
  await new Promise((r) => setTimeout(r, 60));
  const events = await drain(transport);
  assert.deepEqual(events.map((e) => e.timestamp), [9_250, 10_000]);
});

test("a rotated log resets the match state, so the next match starts again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-log-"));
  const path = join(dir, "UnrealEditorFortnite.log");
  await writeFile(path, "");
  const transport = new LogFileTransport({ path, clock: new RealClock(), pollMs: 10 });
  await transport.start();
  await appendFile(path, `${REAL.inProgress}\n${"x".repeat(200)}\n`);
  await new Promise((r) => setTimeout(r, 60));
  await writeFile(path, `${REAL.inProgress}\n`);
  await new Promise((r) => setTimeout(r, 60));
  const events = await drain(transport);
  assert.deepEqual(events.map((e) => e.type), ["game.started", "game.started"]);
});

test("attaching to a running session replays its latest hello and match state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-log-"));
  const path = join(dir, "UnrealEditorFortnite.log");
  const wire = (body: string) => `[2026.10.09-10.00.00:000][  1]LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|${body}`;
  await writeFile(
    path,
    [wire("H|0|0.0.9"), REAL.postGameEnd, wire("H|0|0.1.0"), wire("P|1|poc.counter|v:i=1"), REAL.inProgress, wire("P|2|poc.counter|v:i=2"), ""].join("\n"),
  );
  const transport = new LogFileTransport({ path, clock: fixedClock(), pollMs: 10, backfillBytes: 1024 * 1024 });
  await transport.start();
  // The backfilled match start is not reported a second time.
  transport.assumeGameState(true);
  const events = await drain(transport);
  assert.deepEqual(events.map((e) => e.type), ["session.ready", "game.started"]);
  assert.equal(events[0]!.payload["runtimeVersion"], "0.1.0");
});

test("a match state learned from UEFN emits the missing lifecycle event once", async () => {
  const transport = new LogFileTransport({ path: "/nonexistent/uefn.log", clock: fixedClock() });
  transport.assumeGameState(true);
  transport.assumeGameState(true);
  transport.ingest(REAL.inProgress);
  transport.assumeGameState(false);
  const events = await drain(transport);
  assert.deepEqual(events.map((e) => [e.type, e.payload]), [
    ["game.started", { minigameState: "InProgress", alreadyRunning: true }],
    ["game.ended", { minigameState: "PostGameEnd", alreadyEnded: true }],
  ]);
});

test("after the engine forgets its state, a match UEFN reports running is announced again", async () => {
  const transport = new LogFileTransport({ path: "/nonexistent/uefn.log", clock: fixedClock() });
  transport.ingest(REAL.inProgress);
  transport.assumeGameState(true);
  transport.resetObservedState();
  transport.assumeGameState(true);
  const events = await drain(transport);
  assert.deepEqual(events.map((e) => [e.type, e.payload["alreadyRunning"]]), [
    ["game.started", undefined],
    ["game.started", true],
  ]);
});

test("a backfill ignores hellos from an earlier play session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-log-"));
  const path = join(dir, "UnrealEditorFortnite.log");
  const wire = (body: string) => `[2026.10.11-10.26.06:754][491]LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|${body}`;
  // Seen live on 42.30: every play session launch logs this activity first.
  const launch = "[2026.10.11-10.25.57:426][465]LogValkyrieActivityTracker: Session -> Start Activity: Matchmaking - Attempting matchmaking";
  await writeFile(path, [wire("H|0|0.1.0"), REAL.inProgress, REAL.postGameEnd, launch, REAL.inProgress, ""].join("\n"));
  const transport = new LogFileTransport({ path, clock: fixedClock(), pollMs: 10, backfillBytes: 1024 * 1024 });
  await transport.start();
  const events = await drain(transport);
  // The current session's match is running, but its runtime never said hello.
  assert.deepEqual(events.map((e) => e.type), ["game.started"]);
});

test("a backfill reads back as far as the current session's launch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-log-"));
  const path = join(dir, "UnrealEditorFortnite.log");
  const launch = "[2026.10.11-10.25.57:426][465]LogValkyrieActivityTracker: Session -> Start Activity: Matchmaking - Attempting matchmaking";
  const hello = "[2026.10.11-10.26.06:754][491]LogVerse: DevTools-devtools_log: [UEFN-DEVTOOLS]|1|H|0|0.1.0";
  // Far more log since the hello than one backfill chunk holds.
  const noise = Array.from({ length: 2000 }, (_, i) => `[2026.10.11-10.30.00:000][  1]LogTemp: line ${i} with some padding to make it longer`);
  await writeFile(path, [launch, hello, REAL.inProgress, ...noise, ""].join("\n"));
  const transport = new LogFileTransport({ path, clock: fixedClock(), pollMs: 10, backfillBytes: 4096 });
  await transport.start();
  const events = await drain(transport);
  assert.deepEqual(events.map((e) => e.type), ["session.ready", "game.started"]);
});
