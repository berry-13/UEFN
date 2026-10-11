import { applyEvent, type Recording } from "@uefn-devtools/core";
import type { GameState, RuntimeEvent } from "@uefn-devtools/protocol";
import { EventTypes, emptyGameState } from "@uefn-devtools/protocol";
import { stringify } from "yaml";
import { slugify } from "./names.ts";
import { YamlTestSchema, type Step, type YamlTest } from "./yaml.ts";

export interface GenerateOptions {
  /** Test name; defaults to the recording name. */
  name?: string;
  id?: string;
  /** Emit `wait` steps for gaps between actions (default true). */
  waits?: boolean;
  /** Waits are rounded to a multiple of this many ms (default 500). */
  roundTo?: number;
  /** Gaps shorter than this many ms (before rounding) produce no wait (default 500). */
  minWait?: number;
  /** Outcome events the generated test waits for between actions (default `capture.completed`). */
  waitFor?: string[];
  /** Outcome events asserted with an exact `times` count (default `capture.completed`, `score.changed`). */
  assertEvents?: string[];
  /** Also assert each player's alive flag and team (default false). */
  players?: boolean;
}

export interface GeneratedTest {
  test: YamlTest;
  yaml: string;
}

const DEFAULTS = {
  waits: true,
  roundTo: 500,
  minWait: 500,
  waitFor: [EventTypes.CaptureCompleted],
  assertEvents: [EventTypes.CaptureCompleted, EventTypes.ScoreChanged],
  players: false,
};

/** Events emitted by one command differ by sub-millisecond clock reads; treat anything this close as one action. */
const SAME_ACTION_MS = 50;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function actorOf(e: RuntimeEvent): string | undefined {
  return str(e.payload["player"]) ?? (e.source?.type === "player" ? e.source.id : undefined);
}

/** Whether a later event of the same action (teleport, elimination) already implies the exit `e` (exit on teleport/eliminate). */
function impliedBy(events: readonly RuntimeEvent[], i: number, player: string): boolean {
  const e = events[i]!;
  for (let j = i + 1; j < events.length && events[j]!.timestamp - e.timestamp <= SAME_ACTION_MS; j++) {
    const n = events[j]!;
    if (actorOf(n) !== player && str(n.payload["player"]) !== player) continue;
    if (n.type === EventTypes.PlayerMoved || n.type === EventTypes.PlayerEliminated) return true;
  }
  return false;
}

interface Item {
  timestamp: number;
  step: Step;
  /** Outcome waits do not count as an action when computing leading setup. */
  marker?: boolean;
}

/** Maps observed player actions to the YAML steps that reproduce them. */
function toItems(events: readonly RuntimeEvent[], options: Required<GenerateOptions>): Item[] {
  const items: Item[] = [];
  const enabled = new Map<string, boolean>();
  const waitFor = new Set(options.waitFor);
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const p = e.payload;
    const player = actorOf(e);
    switch (e.type) {
      case EventTypes.GameStarted:
        items.push({ timestamp: e.timestamp, step: "start_game" });
        break;
      case EventTypes.GameEnded:
        items.push({ timestamp: e.timestamp, step: "end_game" });
        break;
      case EventTypes.PlayerSpawned: {
        if (!player) break;
        const team = typeof p["team"] === "number" ? p["team"] : undefined;
        items.push({ timestamp: e.timestamp, step: { spawn_player: { id: player, ...(team !== undefined ? { team } : {}) } } });
        break;
      }
      case EventTypes.PlayerEnteredArea: {
        const area = str(p["device"]) ?? e.target?.id;
        if (player && area) items.push({ timestamp: e.timestamp, step: { enter: { player, area } } });
        break;
      }
      case EventTypes.PlayerExitedArea: {
        const area = str(p["device"]) ?? e.target?.id;
        if (player && area && !impliedBy(events, i, player)) items.push({ timestamp: e.timestamp, step: { leave: { player, area } } });
        break;
      }
      case EventTypes.PlayerStateChanged: {
        const before = p["previous"] as { health?: number; shield?: number } | undefined;
        if (!player || !before) break;
        const amount = (before.health ?? 0) + (before.shield ?? 0) - (Number(p["health"] ?? before.health ?? 0) + Number(p["shield"] ?? before.shield ?? 0));
        if (amount > 0) items.push({ timestamp: e.timestamp, step: { damage: { player, amount } } });
        break;
      }
      case EventTypes.PlayerEliminated: {
        const victim = str(p["player"]) ?? e.target?.id;
        if (!victim) break;
        // Lethal damage already eliminates the player; do not repeat it.
        const last = items[items.length - 1];
        if (last && typeof last.step === "object" && "damage" in last.step && last.step.damage.player === victim && e.timestamp - last.timestamp <= SAME_ACTION_MS) break;
        const by = str(p["by"]);
        items.push({ timestamp: e.timestamp, step: { eliminate: { player: victim, ...(by ? { by } : {}) } } });
        break;
      }
      case EventTypes.DeviceStateChanged: {
        const id = str(p["device"]) ?? e.source?.id;
        if (!id || typeof p["enabled"] !== "boolean") break;
        const previous = enabled.get(id);
        enabled.set(id, p["enabled"]);
        if (previous !== undefined && previous !== p["enabled"]) {
          items.push({ timestamp: e.timestamp, step: p["enabled"] ? { enable_device: { id } } : { disable_device: { id } } });
        }
        break;
      }
      default:
        if (waitFor.has(e.type)) {
          const match: Record<string, unknown> = {};
          const device = str(p["device"]);
          const team = p["team"];
          if (device) match["device"] = device;
          if (typeof team === "number") match["team"] = team;
          items.push({
            timestamp: e.timestamp,
            marker: true,
            step: { wait_for: { event: e.type, ...(Object.keys(match).length > 0 ? { match } : {}), timeout: "30s" } },
          });
        }
    }
  }
  return items;
}

/** Derived state at the end of the recording, rebuilt purely from its events. */
export function recordedState(recording: Pick<Recording, "events">): GameState {
  const state = emptyGameState();
  for (const e of recording.events) applyEvent(state, e);
  return state;
}

function assertionsFor(recording: Recording, options: Required<GenerateOptions>): YamlTest["assert"] {
  const state = recordedState(recording);
  const out: YamlTest["assert"] = [];
  for (const d of Object.values(state.devices).sort((a, b) => a.id.localeCompare(b.id))) {
    if (d.state === undefined && d.owner === undefined && d.enabled) continue;
    out.push({
      device: {
        id: d.id,
        ...(d.state !== undefined ? { state: d.state } : {}),
        ...(d.owner !== undefined ? { owner: d.owner } : {}),
        ...(d.enabled ? {} : { enabled: false }),
      },
    });
  }
  for (const t of Object.values(state.teams).sort((a, b) => a.id - b.id)) out.push({ team: { id: t.id, score: t.score } });
  if (options.players) {
    for (const p of Object.values(state.players).sort((a, b) => a.id.localeCompare(b.id))) {
      out.push({ player: { id: p.id, alive: p.alive, ...(p.team !== undefined ? { team: p.team } : {}) } });
    }
  }
  const counts: Record<string, number> = {};
  for (const e of recording.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  for (const type of options.assertEvents) {
    if (counts[type]) out.push({ event: { type, times: counts[type] } });
  }
  return out;
}

function isArrangement(s: Step): boolean {
  return s === "start_game" || (typeof s === "object" && "spawn_player" in s);
}

/**
 * Turns a recording into a YAML test: observed actions become steps (with
 * rounded waits between them), the derived end state and key outcome events
 * become assertions. The result is validated against {@link YamlTestSchema}.
 */
export function generateYamlTest(recording: Recording, opts: GenerateOptions = {}): GeneratedTest {
  const options = { ...DEFAULTS, ...opts, name: opts.name ?? recording.name, id: opts.id ?? "" } as Required<GenerateOptions>;
  const items = toItems(recording.events, options);

  const steps: Step[] = [];
  let previous: number | undefined;
  // Leading start_game and spawns run back to back: a gap between them is
  // timing noise, and a wait there would cut the setup block short.
  let arranging = true;
  for (const item of items) {
    arranging &&= isArrangement(item.step);
    if (options.waits && previous !== undefined && !arranging) {
      const gap = item.timestamp - previous;
      // A wait_for covers the gap itself; plain waits are rounded.
      if (!item.marker && gap >= options.minWait) {
        const rounded = Math.round(gap / options.roundTo) * options.roundTo;
        if (rounded > 0) steps.push({ wait: formatMs(rounded) });
      }
    }
    if (item.marker && typeof item.step === "object" && "wait_for" in item.step) {
      const gap = previous === undefined ? 0 : item.timestamp - previous;
      item.step.wait_for.timeout = formatMs(Math.max(5000, Math.ceil((gap * 2) / 1000) * 1000));
    }
    if (!item.marker || options.waits) steps.push(item.step);
    previous = item.timestamp;
  }

  // Leading start_game and spawns are the arrangement; the rest is the scenario.
  let split = 0;
  while (split < steps.length && isArrangement(steps[split]!)) split++;

  const test: YamlTest = YamlTestSchema.parse({
    name: options.name,
    id: options.id || slugify(options.name),
    tags: ["recorded"],
    setup: steps.slice(0, split),
    steps: steps.slice(split),
    assert: assertionsFor(recording, options),
  });
  const header =
    `# Generated by 'uefn record' from recording '${recording.name}' (${recording.recordedAt}, adapter ${recording.adapter}).\n` +
    `# Review the waits and assertions before committing.\n`;
  return { test, yaml: header + stringify(test, { lineWidth: 0 }) };
}
