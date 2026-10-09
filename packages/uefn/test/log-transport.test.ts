import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeEvent } from "@uefn-devtools/protocol";
import { LogFileTransport, RealClock } from "@uefn-devtools/uefn";

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
