import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandResult, RuntimeCommand, RuntimeEvent } from "@uefn-devtools/protocol";
import { RealClock, ScenarioTransport, type RuntimeTransport } from "@uefn-devtools/uefn";

const inner: RuntimeTransport = {
  name: "log-file",
  start: async () => {},
  stop: async () => {},
  receive: async function* () {},
  command: async (): Promise<CommandResult> => ({ ok: false, unsupported: true, error: "unsupported" }),
  supportedCommands: () => [],
};

let n = 0;
const ev = (type: string, payload: Record<string, unknown>): RuntimeEvent => ({ id: `e${++n}`, timestamp: 0, type, payload });

test("player actions resolve on the matching step report, in order", async () => {
  const t = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  assert.ok(t.supportedCommands().includes("teleport"));
  const pending = t.command({ type: "spawn_player", player: "player1" });
  t.observe(ev("scenario.started", { steps: 2 }));
  t.observe(ev("scenario.step", { index: 0, action: "spawn_player", player: "player1" }));
  assert.deepEqual(await pending, { ok: true });
  t.observe(ev("scenario.step", { index: 1, action: "damage_player", player: "player1" }));
  const wrong = await t.command({ type: "teleport", player: "player1", location: "A" } as RuntimeCommand);
  assert.equal(wrong.ok, false);
  assert.match(wrong.error!, /was 'damage_player' in game/);
});

test("a device-side failure or a missing report fails the step", async () => {
  const t = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 20 });
  t.observe(ev("scenario.failed", { index: 0, reason: "player 1 has no character" }));
  const failed = await t.command({ type: "spawn_player", player: "player1" });
  assert.match(failed.error!, /failed in game: player 1 has no character/);
  const missing = await t.command({ type: "damage_player", player: "player1", amount: 5 });
  assert.match(missing.error!, /not reported within 20ms/);
  // Other commands still go to the wrapped transport.
  assert.equal((await t.command({ type: "start_game" })).unsupported, true);
});
