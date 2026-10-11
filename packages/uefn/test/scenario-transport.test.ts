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

test("reports from a second scenario device are ignored and fail the next step", async () => {
  const t = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  t.observe(ev("scenario.started", { scenario: "mine", plan: "aaa", steps: 1 }));
  t.observe(ev("scenario.step", { scenario: "other", index: 0, action: "teleport", player: "player1", arg: "X" }));
  t.observe(ev("scenario.step", { scenario: "mine", index: 0, action: "spawn_player", player: "player1", arg: "" }));
  assert.deepEqual(await t.command({ type: "spawn_player", player: "player1" }), { ok: true });
  t.observe(ev("scenario.started", { scenario: "other", plan: "bbb", steps: 1 }));
  const conflict = await t.command({ type: "damage_player", player: "player1", amount: 5 });
  assert.match(conflict.error!, /'mine' and 'other' both run in this match; place one scenario device per test/);
  // A new match releases the lock.
  t.observe(ev("game.ended", {}));
  t.observe(ev("scenario.started", { scenario: "other", plan: "bbb", steps: 1 }));
  t.observe(ev("scenario.step", { scenario: "other", index: 0, action: "damage_player", player: "player1", arg: "5" }));
  assert.deepEqual(await t.command({ type: "damage_player", player: "player1", amount: 5 }), { ok: true });
});

test("a stale device is detected by its plan fingerprint or step argument", async () => {
  const t = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  t.observe(ev("scenario.started", { scenario: "s", plan: "new", steps: 1 }));
  t.observe(ev("scenario.started", { scenario: "s", plan: "old", steps: 1 }));
  assert.match((await t.command({ type: "spawn_player", player: "player1" })).error!, /two builds of scenario 's' \(plans new and old\)/);

  const u = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  u.observe(ev("scenario.started", { scenario: "s", plan: "p", steps: 2 }));
  u.observe(ev("scenario.step", { scenario: "s", index: 0, action: "teleport", player: "player1", arg: "A" }));
  u.observe(ev("scenario.step", { scenario: "s", index: 1, action: "damage_player", player: "player1", arg: "25" }));
  assert.deepEqual(await u.command({ type: "teleport", player: "player1", location: "A" }), { ok: true });
  const stale = await u.command({ type: "damage_player", player: "player1", amount: 30 });
  assert.match(stale.error!, /ran with '25' in game but the test sent '30'; the placed device is stale/);
});

test("a second scenario device fails a waiting step at once, not at the timeout", async () => {
  const t = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 60_000 });
  t.observe(ev("scenario.started", { scenario: "mine", plan: "aaa", steps: 1 }));
  const started = Date.now();
  const pending = t.command({ type: "spawn_player", player: "player1" });
  t.observe(ev("scenario.started", { scenario: "other", plan: "bbb", steps: 1 }));
  const result = await pending;
  assert.match(result.error!, /'mine' and 'other' both run in this match/);
  assert.ok(Date.now() - started < 1000);
});

test("a device's implicit spawn is matched whether or not the host sends it", async () => {
  const reports = (t: ScenarioTransport) => {
    t.observe(ev("scenario.started", { scenario: "s", plan: "p", steps: 2 }));
    t.observe(ev("scenario.step", { scenario: "s", index: 0, action: "spawn_player", player: "player1", arg: "implicit" }));
    t.observe(ev("scenario.step", { scenario: "s", index: 1, action: "teleport", player: "player1", arg: "A" }));
  };
  const teleport = { type: "teleport", player: "player1", location: "A" } as RuntimeCommand;
  // The host still saw the player down and spawned first.
  const spawned = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  reports(spawned);
  assert.deepEqual(await spawned.command({ type: "spawn_player", player: "player1" }), { ok: true });
  assert.deepEqual(await spawned.command(teleport), { ok: true });
  // The device's spawn report arrived first, so the host moved the player directly.
  const direct = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  reports(direct);
  assert.deepEqual(await direct.command(teleport), { ok: true });
  // Only an implicit spawn of the same player is passed over.
  const other = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  reports(other);
  assert.match((await other.command({ type: "teleport", player: "player2", location: "A" } as RuntimeCommand)).error!, /was 'spawn_player' in game/);
});

test("a match end drops its reports and fails a waiting step", async () => {
  const t = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 60_000 });
  t.observe(ev("scenario.started", { scenario: "s", plan: "p", steps: 2 }));
  t.observe(ev("scenario.step", { scenario: "s", index: 0, action: "spawn_player", player: "player1", arg: "" }));
  t.observe(ev("scenario.step", { scenario: "s", index: 1, action: "damage_player", player: "player1", arg: "5" }));
  assert.deepEqual(await t.command({ type: "spawn_player", player: "player1" }), { ok: true });
  // The attempt ends with step 1 unconsumed; a retry in the next match must not see it.
  t.observe(ev("game.ended", {}));
  const started = Date.now();
  const pending = t.command({ type: "spawn_player", player: "player1" });
  t.observe(ev("game.ended", {}));
  assert.match((await pending).error!, /step 0 \(spawn_player\) was not reported: the match ended/);
  assert.ok(Date.now() - started < 1000);
  t.observe(ev("scenario.started", { scenario: "s", plan: "p", steps: 2 }));
  t.observe(ev("scenario.step", { scenario: "s", index: 0, action: "spawn_player", player: "player1", arg: "" }));
  assert.deepEqual(await t.command({ type: "spawn_player", player: "player1" }), { ok: true });
});

test("a single placed device must be the one the running test generates", async () => {
  const stale = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  stale.expectScenario({ id: "s", plan: "new" });
  stale.observe(ev("scenario.started", { scenario: "s", plan: "old", steps: 1 }));
  stale.observe(ev("scenario.step", { scenario: "s", index: 0, action: "spawn_player", player: "player1", arg: "" }));
  assert.match((await stale.command({ type: "spawn_player", player: "player1" })).error!, /stale \(plan old, the test generates new\)/);
  const foreign = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  foreign.expectScenario({ id: "s", plan: "new" });
  foreign.observe(ev("scenario.started", { scenario: "other", plan: "new", steps: 1 }));
  assert.match((await foreign.command({ type: "spawn_player", player: "player1" })).error!, /is for 'other', not 's'/);
  const current = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  current.expectScenario({ id: "s", plan: "new" });
  current.observe(ev("scenario.started", { scenario: "s", plan: "new", steps: 1 }));
  current.observe(ev("scenario.step", { scenario: "s", index: 0, action: "spawn_player", player: "player1", arg: "" }));
  assert.deepEqual(await current.command({ type: "spawn_player", player: "player1" }), { ok: true });
});

test("a host spawn after a lethal damage step is covered by the device's next move", async () => {
  const t = new ScenarioTransport(inner, { clock: new RealClock(), stepTimeoutMs: 1000 });
  t.observe(ev("scenario.started", { scenario: "s", plan: "p", steps: 2 }));
  t.observe(ev("scenario.step", { scenario: "s", index: 0, action: "damage_player", player: "player1", arg: "500" }));
  t.observe(ev("scenario.step", { scenario: "s", index: 1, action: "teleport", player: "player1", arg: "A" }));
  assert.deepEqual(await t.command({ type: "damage_player", player: "player1", amount: 500 }), { ok: true });
  assert.deepEqual(await t.command({ type: "spawn_player", player: "player1" }), { ok: true });
  assert.deepEqual(await t.command({ type: "teleport", player: "player1", location: "A" } as RuntimeCommand), { ok: true });
});
