import { detectAnomalies } from "@uefn-devtools/core";
import type { GameState, Recording, RuntimeEvent } from "@uefn-devtools/protocol";
import { EventTypes } from "@uefn-devtools/protocol";
import { stringify } from "yaml";
import { slugify } from "./names.ts";
import type { YamlAssertion, YamlStep } from "./yaml.ts";

/**
 * Turns a recording into an editable test (spec §22).
 *
 * The central rule is separating **actions** (what a player or the test does:
 * spawn, enter, eliminate, damage…) from **observed side effects** (captures,
 * score changes, device states). Actions become steps. Side effects become
 * `wait_for` synchronisation points and final-state assertions, never steps.
 * Intermediate states are not asserted, which keeps generated tests from
 * being brittle.
 */
export interface GeneratedTest {
  name: string;
  id: string;
  setup: YamlStep[];
  steps: YamlStep[];
  assert: YamlAssertion[];
  /** Human-readable caveats, emitted as comments. */
  notes: string[];
}

export interface GenerateOptions {
  name?: string;
  /** Also assert exact counts of milestone events (stricter, more brittle). */
  counts?: boolean;
}

/** Events that are bookkeeping or intermediate state, never synchronisation points. */
const NON_MILESTONES = new Set<string>([
  EventTypes.SessionReady,
  EventTypes.PlayerMoved,
  EventTypes.DeviceStateChanged,
  EventTypes.PlayerStateChanged,
  EventTypes.ProbeUpdated,
  EventTypes.Log,
]);

/** Events that are actions a test can drive. */
const ACTION_TYPES = new Set<string>([
  EventTypes.GameStarted,
  EventTypes.GameEnded,
  EventTypes.PlayerSpawned,
  EventTypes.PlayerEnteredArea,
  EventTypes.PlayerExitedArea,
  EventTypes.PlayerEliminated,
  EventTypes.PlayerStateChanged,
  EventTypes.PlayerMoved,
]);

/** Effects of one action land in the same tick; this is the window for "caused by". */
const SAME_TICK_MS = 5;
const MIN_WAIT_MS = 1000;

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function playerOf(e: RuntimeEvent): string | undefined {
  return str(e.payload["player"]) ?? (e.source?.type === "player" ? e.source.id : e.target?.type === "player" ? e.target.id : undefined);
}

/**
 * The run of consecutive events (in log order) that concern the same player
 * as `events[i]`. One action's effects are emitted back to back (a teleport
 * writes exit → move → enter), so adjacency identifies "caused by the same
 * action" independently of clock speed. Timestamps are not reliable for
 * this: the simulator compresses time, a real log batches lines.
 */
function sameActionRun(events: readonly RuntimeEvent[], i: number, direction: 1 | -1): RuntimeEvent[] {
  const player = playerOf(events[i]!);
  const out: RuntimeEvent[] = [];
  for (let j = i + direction; j >= 0 && j < events.length; j += direction) {
    const e = events[j]!;
    const sameTick = Math.abs(e.timestamp - events[i]!.timestamp) <= SAME_TICK_MS;
    if (playerOf(e) !== player && !sameTick) break;
    if (playerOf(e) === player) out.push(e);
    else if (!sameTick) break;
  }
  return out;
}

function soon(events: readonly RuntimeEvent[], i: number, pred: (e: RuntimeEvent) => boolean): boolean {
  return sameActionRun(events, i, 1).some(pred);
}

function recent(events: readonly RuntimeEvent[], i: number, pred: (e: RuntimeEvent) => boolean): boolean {
  return sameActionRun(events, i, -1).some(pred);
}

/** Damage that brought `player` to 0 health (the elimination that follows is its effect). */
function killedBy(e: RuntimeEvent, player: string): boolean {
  return e.type === EventTypes.PlayerStateChanged && playerOf(e) === player && num(e.payload["health"]) === 0;
}

/** Maps one event to a step, or `undefined` when it is a side effect. */
function toAction(events: readonly RuntimeEvent[], i: number): YamlStep | undefined {
  const e = events[i]!;
  const p = e.payload;
  const player = playerOf(e);
  switch (e.type) {
    case EventTypes.GameStarted:
      return "start_game";
    case EventTypes.GameEnded:
      return "end_game";
    case EventTypes.PlayerSpawned: {
      if (!player) return undefined;
      const team = num(p["team"]);
      return { spawn_player: { id: player, ...(team !== undefined ? { team } : {}) } };
    }
    case EventTypes.PlayerEnteredArea: {
      const area = str(p["device"]) ?? e.target?.id;
      return player && area ? { enter: { player, area } } : undefined;
    }
    case EventTypes.PlayerExitedArea: {
      const area = str(p["device"]) ?? e.target?.id;
      if (!player || !area) return undefined;
      // Leaving because of a teleport or an elimination is a side effect.
      const caused = soon(events, i, (n) =>
        playerOf(n) === player &&
        (n.type === EventTypes.PlayerMoved || n.type === EventTypes.PlayerEnteredArea || n.type === EventTypes.PlayerEliminated),
      ) || recent(events, i, (n) => killedBy(n, player));
      return caused ? undefined : { leave: { player, area } };
    }
    case EventTypes.PlayerEliminated: {
      const victim = str(p["player"]) ?? e.target?.id;
      if (!victim) return undefined;
      // Eliminations caused by recorded damage are already covered by that step.
      if (recent(events, i, (n) => killedBy(n, victim))) return undefined;
      const by = str(p["by"]);
      return { eliminate: { player: victim, ...(by ? { by } : {}) } };
    }
    case EventTypes.PlayerStateChanged: {
      const prev = p["previous"] as Record<string, unknown> | undefined;
      const before = (num(prev?.["health"]) ?? NaN) + (num(prev?.["shield"]) ?? 0);
      const after = (num(p["health"]) ?? NaN) + (num(p["shield"]) ?? 0);
      if (!player || !(before > after)) return undefined;
      return { damage: { player, amount: before - after } };
    }
    case EventTypes.PlayerMoved: {
      // A move that lands in an area is represented by the `enter` step.
      const location = str(p["location"]);
      if (!player || !location) return undefined;
      if (soon(events, i, (n) => n.type === EventTypes.PlayerEnteredArea && playerOf(n) === player)) return undefined;
      return { teleport: { player, location } };
    }
  }
  return undefined;
}

/** Payload keys that identify a milestone without over-fitting to values. */
const IDENTIFYING_KEYS = ["device", "player", "team"];

function matchFor(e: RuntimeEvent): Record<string, unknown> | undefined {
  const match: Record<string, unknown> = {};
  for (const k of IDENTIFYING_KEYS) if (e.payload[k] !== undefined && e.payload[k] !== null) match[k] = e.payload[k];
  return Object.keys(match).length ? match : undefined;
}

function milestoneKey(e: RuntimeEvent): string {
  return `${e.type}|${JSON.stringify(matchFor(e) ?? {})}`;
}

export function generateTest(recording: Recording, options: GenerateOptions = {}): GeneratedTest {
  const events = recording.events;
  const notes: string[] = [];
  const steps: YamlStep[] = [];
  const occurrences = new Map<string, number>();

  const actionIdx: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (!ACTION_TYPES.has(events[i]!.type)) continue;
    const step = toAction(events, i);
    if (step) actionIdx.push(i);
  }

  const midGame = !events.some((e) => e.type === EventTypes.GameStarted);
  if (midGame) {
    steps.push("start_game");
    notes.push("The recording began mid-game. The generated test starts a fresh game, so scores are asserted as gains during the recording.");
  }

  // Area occupancy is what makes elapsed time matter (captures progress while
  // someone stands in an area). Waits recorded while nobody is in an area are
  // human think time and are dropped.
  const occupied = new Map<string, Set<string>>();
  let occCursor = 0;
  const occupancyUntil = (idx: number) => {
    for (; occCursor < idx; occCursor++) {
      const e = events[occCursor]!;
      const player = playerOf(e);
      const area = str(e.payload["device"]) ?? e.target?.id;
      if (e.type === EventTypes.PlayerEnteredArea && player && area) {
        (occupied.get(player) ?? occupied.set(player, new Set()).get(player)!).add(area);
      } else if (e.type === EventTypes.PlayerExitedArea && player && area) occupied.get(player)?.delete(area);
      else if (e.type === EventTypes.PlayerEliminated) {
        const victim = str(e.payload["player"]) ?? e.target?.id;
        if (victim) occupied.delete(victim);
      }
    }
    return [...occupied.values()].some((areas) => areas.size > 0);
  };

  let cursor = 0;
  let lastActionAt = actionIdx.length ? events[actionIdx[0]!]!.timestamp : events[0]?.timestamp ?? 0;
  const flushMilestones = (untilExclusive: number, nextActionAt: number | undefined) => {
    const timeMatters = occupancyUntil(untilExclusive);
    let lastMilestone: RuntimeEvent | undefined;
    for (; cursor < untilExclusive; cursor++) {
      const e = events[cursor]!;
      if (ACTION_TYPES.has(e.type) || NON_MILESTONES.has(e.type) || e.type.startsWith("session.")) continue;
      const key = milestoneKey(e);
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
      lastMilestone = e;
    }
    let syncedAt = lastActionAt;
    if (lastMilestone) {
      const match = matchFor(lastMilestone);
      const count = occurrences.get(milestoneKey(lastMilestone))!;
      const waited = lastMilestone.timestamp - lastActionAt;
      steps.push({
        wait_for: {
          event: lastMilestone.type,
          ...(match ? { match } : {}),
          ...(count > 1 ? { count } : {}),
          // Generous headroom: the recording is one sample of the timing.
          timeout: `${Math.max(5, Math.ceil((waited * 2) / 1000))}s`,
        },
      });
      syncedAt = lastMilestone.timestamp;
    }
    if (timeMatters && nextActionAt !== undefined && nextActionAt - syncedAt >= MIN_WAIT_MS) {
      steps.push({ wait: `${Math.round((nextActionAt - syncedAt) / 100) / 10}s` });
    }
  };

  for (const i of actionIdx) {
    flushMilestones(i, events[i]!.timestamp);
    steps.push(toAction(events, i)!);
    lastActionAt = events[i]!.timestamp;
    cursor = i + 1;
  }
  flushMilestones(events.length, undefined);

  // Mid-game recordings start with the synthetic start_game; the players who
  // were already playing join right after it.
  steps.splice(midGame ? 1 : 0, 0, ...preexistingPlayers(recording, steps, notes));

  // Leading start/spawn steps read better as setup.
  const setup: YamlStep[] = [];
  while (steps.length && (steps[0] === "start_game" || (typeof steps[0] === "object" && "spawn_player" in steps[0]!))) {
    setup.push(steps.shift()!);
  }

  const assert = finalAssertions(events, options, notes);
  if (assert.length === 0) notes.push("Nothing observable changed during the recording, so there is nothing to assert yet.");
  if (actionIdx.length === 0) notes.push("No actions were recognised; only observations were recorded.");

  if (recording.kind === "bug") {
    notes.unshift(
      "BUG RECORDING: the assertions below are the values that were OBSERVED, including the buggy ones.",
      "Change them to the EXPECTED behaviour; the test should then fail until the bug is fixed.",
    );
    for (const a of detectAnomalies(events)) notes.push(`anomaly [${a.severity}]: ${a.message}`);
  }

  const name = options.name ?? recording.name;
  return { name, id: slugify(name), setup, steps, assert, notes };
}

const ACTOR_KEYS = ["enter", "leave", "teleport", "damage", "eliminate"] as const;

/**
 * Players who act in the recording but spawned before it began. Without a
 * setup step the replay would spawn them on a default team (or, for `leave`,
 * not at all), so they are spawned first with their recorded team and put
 * back into the areas they occupied. Teams come from the state snapshot taken
 * when recording started, else from any event payload that names them.
 */
function preexistingPlayers(recording: Recording, steps: YamlStep[], notes: string[]): YamlStep[] {
  const spawned = new Set<string>();
  const actors: string[] = [];
  for (const step of steps) {
    if (typeof step !== "object") continue;
    if ("spawn_player" in step) spawned.add(String(step.spawn_player.id));
    for (const key of ACTOR_KEYS) {
      if (!(key in step)) continue;
      const player = String((step as Record<string, { player: string | number }>)[key]!.player);
      if (!spawned.has(player) && !actors.includes(player)) actors.push(player);
    }
  }
  const initial = recording.initialState as unknown as GameState | undefined;
  // Players standing in an area cause effects (captures) without acting.
  for (const p of Object.values(initial?.players ?? {})) {
    if (p.alive && p.areas.length && !spawned.has(p.id) && !actors.includes(p.id)) actors.push(p.id);
  }
  if (actors.length === 0) return [];
  const inferredTeam = (player: string): number | undefined => {
    for (const e of recording.events) {
      if (playerOf(e) === player && num(e.payload["team"]) !== undefined) return num(e.payload["team"]);
    }
    return undefined;
  };
  const out: YamlStep[] = [];
  const reentered: string[] = [];
  for (const player of actors) {
    const known = initial?.players?.[player];
    const team = known?.team ?? inferredTeam(player);
    out.push({ spawn_player: { id: player, ...(team !== undefined ? { team } : {}) } });
    if (team === undefined) notes.push(`${player} was already in the game when recording started and their team is unknown; set it in spawn_player.`);
    for (const area of known?.alive ? known.areas : []) {
      out.push({ enter: { player, area } });
      reentered.push(`${player} → ${area}`);
    }
  }
  if (reentered.length) {
    notes.push(`Players were inside areas when recording started (${reentered.join(", ")}); the replay re-enters them, so progress made before the recording is not reproduced.`);
  }
  return out;
}

function finalAssertions(events: readonly RuntimeEvent[], options: GenerateOptions, notes: string[]): YamlAssertion[] {
  const out: YamlAssertion[] = [];
  const devices = new Map<string, { state?: string; owner?: number | null; seen: Set<string> }>();
  const teamGain = new Map<number, number>();
  const alive = new Map<string, boolean>();
  const probes = new Map<string, unknown>();
  const milestoneCounts = new Map<string, { type: string; match?: Record<string, unknown>; n: number }>();

  for (const e of events) {
    const p = e.payload;
    if (e.type === EventTypes.DeviceStateChanged) {
      const id = str(p["device"]) ?? e.source?.id;
      if (!id) continue;
      const d = devices.get(id) ?? { seen: new Set<string>() };
      if (typeof p["state"] === "string") d.state = p["state"];
      if ("owner" in p) d.owner = num(p["owner"]) ?? null;
      d.seen.add(JSON.stringify([d.state ?? null, d.owner ?? null]));
      devices.set(id, d);
    } else if (e.type === EventTypes.ScoreChanged) {
      const team = num(p["team"]) ?? (e.target?.type === "team" ? Number(e.target.id) : undefined);
      if (team === undefined || Number.isNaN(team)) continue;
      const delta = num(p["delta"]) ?? (num(p["current"]) !== undefined && num(p["previous"]) !== undefined ? num(p["current"])! - num(p["previous"])! : undefined);
      if (delta === undefined) {
        notes.push(`score.changed for team ${team} has no delta/previous; its score is not asserted.`);
        continue;
      }
      teamGain.set(team, (teamGain.get(team) ?? 0) + delta);
    } else if (e.type === EventTypes.PlayerEliminated) {
      const victim = str(p["player"]) ?? e.target?.id;
      if (victim) alive.set(victim, false);
    } else if (e.type === EventTypes.PlayerSpawned) {
      const id = playerOf(e);
      if (id && alive.has(id)) alive.set(id, true);
    } else if (e.type === EventTypes.ProbeUpdated) {
      const id = str(p["probe"]);
      if (id) probes.set(id, p["value"]);
    }
    if (!ACTION_TYPES.has(e.type) && !NON_MILESTONES.has(e.type) && !e.type.startsWith("session.")) {
      const match = matchFor(e);
      const key = milestoneKey(e);
      const c = milestoneCounts.get(key) ?? { type: e.type, ...(match ? { match } : {}), n: 0 };
      c.n++;
      milestoneCounts.set(key, c);
    }
  }

  for (const [id, d] of [...devices].sort(([a], [b]) => a.localeCompare(b))) {
    // Only devices whose state changed during the recording; a device merely
    // reported at game start is not part of the behaviour being recorded.
    if (d.seen.size < 2 || (d.state === undefined && d.owner === undefined)) continue;
    out.push({ device: { id, ...(d.state !== undefined ? { state: d.state } : {}), ...(d.owner !== undefined ? { owner: d.owner } : {}) } });
  }
  for (const [team, score] of [...teamGain].sort(([a], [b]) => a - b)) out.push({ team: { id: team, score } });
  for (const [player, isAlive] of [...alive].sort(([a], [b]) => a.localeCompare(b))) out.push({ player: { id: player, alive: isAlive } });
  for (const [id, value] of [...probes].sort(([a], [b]) => a.localeCompare(b))) out.push({ probe: { id, value } });
  if (options.counts) {
    for (const c of milestoneCounts.values()) out.push({ event: { type: c.type, ...(c.match ? { match: c.match } : {}), times: c.n } });
  }
  return out;
}

/**
 * Comments carry runtime-controlled text (anomaly messages quote log lines).
 * Any line terminator would end the comment and let that text become code,
 * so all of them, including the JavaScript-only U+2028/U+2029, are folded.
 */
function commentText(text: string): string {
  return text.replace(/[\r\n\u2028\u2029\u0085]+/g, " ");
}

export function toYaml(test: GeneratedTest, source?: { recordingId: string }): string {
  const header = [
    `# Generated by UEFN DevTools${source ? ` from recording ${commentText(source.recordingId)}` : ""}.`,
    "# Steps are recorded actions; assertions are the final observed state. Edit freely.",
    ...test.notes.map((n) => `# NOTE: ${commentText(n)}`),
  ].join("\n");
  const doc = { name: test.name, id: test.id, setup: test.setup, steps: test.steps, assert: test.assert };
  return `${header}\n${stringify(doc, { lineWidth: 0 })}`;
}

/** Words that cannot be binding names in a module (strict mode), plus globals worth not shadowing. */
const JS_RESERVED = [
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "package", "private", "protected", "public", "return",
  "static", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
  "yield", "arguments", "eval", "undefined", "NaN", "Infinity",
];

function tsValue(v: unknown): string {
  return JSON.stringify(v);
}

export function toTypeScript(test: GeneratedTest, source?: { recordingId: string }): string {
  const lines: string[] = [
    `// Generated by UEFN DevTools${source ? ` from recording ${commentText(source.recordingId)}` : ""}.`,
    "// Steps are recorded actions; assertions are the final observed state. Edit freely.",
    ...test.notes.map((n) => `// NOTE: ${commentText(n)}`),
    `import { expect, test } from "@uefn-devtools/test";`,
    "",
    `test(${tsValue(test.name)}, async ({ game }) => {`,
  ];
  // One handle per player, declared up front, as a person would write it.
  const teams = new Map<string, number | undefined>();
  const ids: string[] = [];
  const see = (id: string | number, team?: number) => {
    const key = String(id);
    if (!ids.includes(key)) ids.push(key);
    if (team !== undefined || !teams.has(key)) teams.set(key, team ?? teams.get(key));
  };
  for (const s of [...test.setup, ...test.steps]) {
    if (typeof s !== "object") continue;
    if ("spawn_player" in s) see(s.spawn_player.id, s.spawn_player.team);
    for (const k of ["enter", "teleport", "leave", "eliminate", "damage"] as const) {
      if (k in s) see((s as Record<string, { player: string | number }>)[k]!.player);
    }
  }
  for (const a of test.assert) if ("player" in a) see(a.player.id);
  const names = new Map<string, string>();
  const used = new Set(["game", "expect", "test", ...JS_RESERVED]);
  for (const id of ids) {
    let name = id.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[^A-Za-z_$]/, "p$&") || "player";
    name = name[0]!.toLowerCase() + name.slice(1);
    while (used.has(name)) name += "_";
    used.add(name);
    names.set(id, name);
    const team = teams.get(id);
    lines.push(`  const ${name} = game.player(${tsValue(id)}${team !== undefined ? `, { team: ${team} }` : ""});`);
  }
  if (ids.length) lines.push("");
  const player = (id: string | number) => names.get(String(id))!;
  for (const s of [...test.setup, ...test.steps]) {
    if (s === "start_game" || (typeof s === "object" && "start_game" in s)) lines.push("  await game.start();");
    else if (s === "end_game" || (typeof s === "object" && "end_game" in s)) lines.push("  await game.end();");
    else if ("spawn_player" in s) lines.push(`  await ${player(s.spawn_player.id)}.spawn();`);
    else if ("enter" in s) lines.push(`  await ${player(s.enter.player)}.enter(${tsValue(s.enter.area)});`);
    else if ("teleport" in s) lines.push(`  await ${player(s.teleport.player)}.teleport(${tsValue(s.teleport.location)});`);
    else if ("leave" in s) lines.push(`  await ${player(s.leave.player)}.leave(${tsValue(s.leave.area)});`);
    else if ("eliminate" in s) lines.push(`  await ${player(s.eliminate.player)}.eliminate(${s.eliminate.by ? `{ by: ${tsValue(s.eliminate.by)} }` : ""});`);
    else if ("damage" in s) lines.push(`  await ${player(s.damage.player)}.damage(${s.damage.amount});`);
    else if ("enable_device" in s) lines.push(`  await game.device(${tsValue(s.enable_device.id)}).enable();`);
    else if ("disable_device" in s) lines.push(`  await game.device(${tsValue(s.disable_device.id)}).disable();`);
    else if ("wait" in s) lines.push(`  await game.wait(${tsValue(s.wait)});`);
    else if ("wait_for" in s) {
      const w = s.wait_for;
      const opts = [w.timeout !== undefined ? `timeout: ${tsValue(w.timeout)}` : "", w.count ? `count: ${w.count}` : ""].filter(Boolean).join(", ");
      lines.push(`  await game.waitForEvent(${tsValue(w.event)}, ${w.match ? tsValue(w.match) : "undefined"}${opts ? `, { ${opts} }` : ""});`);
    }
  }
  if (test.assert.length) lines.push("");
  for (const a of test.assert) {
    if ("device" in a) {
      const d = a.device;
      if (d.state !== undefined) lines.push(`  await expect(game.device(${tsValue(d.id)})).toHaveState(${tsValue(d.state)});`);
      if (d.owner !== undefined) lines.push(`  await expect(game.device(${tsValue(d.id)})).toHaveOwner(${tsValue(d.owner)});`);
    } else if ("team" in a) lines.push(`  await expect(game.team(${a.team.id})).toHaveScore(${a.team.score});`);
    else if ("player" in a) {
      if (a.player.alive === false) lines.push(`  await expect(${player(a.player.id)}).toBeEliminated();`);
      if (a.player.alive === true) lines.push(`  await expect(${player(a.player.id)}).toBeAlive();`);
    } else if ("probe" in a) lines.push(`  await expect(game.probe(${tsValue(a.probe.id)})).toHaveValue(${tsValue(a.probe.value)});`);
    else if ("event" in a) {
      lines.push(`  await expect(game.events).toHaveOccurred(${tsValue(a.event.type)}, ${a.event.match ? tsValue(a.event.match) : "undefined"}${a.event.times !== undefined ? `, { times: ${a.event.times} }` : ""});`);
    }
  }
  lines.push("});", "");
  return lines.join("\n");
}

/**
 * Writes a generated test into the tests directory as
 * `<slug>.recorded.test.<ext>`, never overwriting: a numeric suffix is added
 * when the name is taken.
 */
// Id allocation reads the suite and then creates a file; two concurrent
// generations (e.g. YAML and TS in one RPC batch) must not both pick the
// same id, so allocation is serialised process-wide.
const WRITE_LOCK = Symbol.for("uefn-devtools.generate.write-lock");
const gl = globalThis as unknown as Record<symbol, Promise<unknown> | undefined>;

export function writeGeneratedTest(
  testsDir: string,
  test: GeneratedTest,
  format: "yaml" | "ts",
  source?: { recordingId: string },
): Promise<string> {
  const run = () => writeGeneratedTestUnlocked(testsDir, test, format, source);
  const next = (gl[WRITE_LOCK] ?? Promise.resolve()).then(run, run);
  gl[WRITE_LOCK] = next.catch(() => {});
  return next;
}

async function writeGeneratedTestUnlocked(
  testsDir: string,
  test: GeneratedTest,
  format: "yaml" | "ts",
  source?: { recordingId: string },
): Promise<string> {
  if (test.assert.length === 0) {
    // The runner fails tests without assertions; writing one would only add a red test.
    throw new Error("the recording has nothing to assert (no observable state changed), so no test was written");
  }
  const { mkdir, writeFile, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { findTestFiles, loadTests } = await import("./discover.ts");
  await mkdir(testsDir, { recursive: true });
  // Test ids must be unique across the suite, so the id (not just the file
  // name) gets the suffix. Ids already used by any test, in either format,
  // are taken.
  const taken = new Set((await loadTests(await findTestFiles(testsDir))).tests.map((t) => t.id));
  const exists = (p: string) => stat(p).then(() => true, () => false);
  const ext = format === "ts" ? "ts" : "yaml";
  for (let n = 1; n < 1000; n++) {
    const id = n > 1 ? `${test.id}-${n}` : test.id;
    const base = join(testsDir, `${id}.recorded.test`);
    if (taken.has(id) || (await exists(`${base}.yaml`)) || (await exists(`${base}.ts`))) continue;
    const unique: GeneratedTest = n > 1 ? { ...test, id, name: `${test.name} (${n})` } : test;
    // TypeScript ids derive from the name; keep them in step with the file.
    const body = format === "ts" ? toTypeScript(unique, source) : toYaml(unique, source);
    try {
      await writeFile(`${base}.${ext}`, body, { flag: "wx" });
      return `${base}.${ext}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not find a free test id for ${test.id}`);
}
