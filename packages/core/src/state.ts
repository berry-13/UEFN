import type { DeviceState, GameState, PlayerState, RuntimeEvent } from "@uefn-devtools/protocol";
import { EventTypes, emptyGameState } from "@uefn-devtools/protocol";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function player(state: GameState, id: string): PlayerState {
  let p = state.players[id];
  if (!p) {
    p = { id, alive: true, score: 0, eliminations: 0, deaths: 0, areas: [], extra: {} };
    state.players[id] = p;
  }
  return p;
}

function device(state: GameState, id: string): DeviceState {
  let d = state.devices[id];
  if (!d) {
    d = { id, enabled: true, triggerCount: 0, extra: {} };
    state.devices[id] = d;
  }
  return d;
}

const KNOWN_DEVICE_KEYS = new Set(["device", "deviceType", "state", "enabled", "owner", "progress"]);

/**
 * Pure-ish reducer from RuntimeEvent to the shared GameState. Mutates and
 * returns `state`; replaying the same events always yields the same state.
 */
export function applyEvent(state: GameState, event: RuntimeEvent): GameState {
  const p = event.payload;
  const playerId = str(p["player"]) ?? (event.source?.type === "player" ? event.source.id : undefined);
  switch (event.type) {
    case EventTypes.GameStarted:
      state.phase = "playing";
      state.round += 1;
      state.startedAt = event.timestamp;
      delete state.endedAt;
      delete state.winner;
      for (const team of Object.values(state.teams)) team.score = 0;
      break;
    case EventTypes.GameEnded: {
      state.phase = "ended";
      state.endedAt = event.timestamp;
      const winner = num(p["winner"]);
      if (winner !== undefined) state.winner = winner;
      break;
    }
    case EventTypes.PlayerSpawned: {
      if (!playerId) break;
      const pl = player(state, playerId);
      pl.alive = true;
      pl.areas = [];
      const team = num(p["team"]);
      if (team !== undefined) pl.team = team;
      const health = num(p["health"]);
      if (health !== undefined) pl.health = health;
      const shield = num(p["shield"]);
      if (shield !== undefined) pl.shield = shield;
      if (Array.isArray(p["position"])) pl.position = p["position"] as PlayerState["position"] & object;
      break;
    }
    case EventTypes.PlayerMoved:
      if (playerId && Array.isArray(p["position"])) player(state, playerId).position = p["position"] as [number, number, number];
      break;
    case EventTypes.PlayerEnteredArea: {
      const area = str(p["device"]) ?? event.target?.id;
      if (playerId && area) {
        const pl = player(state, playerId);
        if (!pl.areas.includes(area)) pl.areas.push(area);
        device(state, area).triggerCount += 1;
      }
      break;
    }
    case EventTypes.PlayerExitedArea: {
      const area = str(p["device"]) ?? event.target?.id;
      if (playerId && area) player(state, playerId).areas = player(state, playerId).areas.filter((a) => a !== area);
      break;
    }
    case EventTypes.PlayerEliminated: {
      const victim = str(p["player"]) ?? event.target?.id;
      if (victim) {
        const pl = player(state, victim);
        pl.alive = false;
        pl.health = 0;
        pl.areas = [];
        pl.deaths += 1;
      }
      const by = str(p["by"]);
      if (by) player(state, by).eliminations += 1;
      break;
    }
    case EventTypes.PlayerStateChanged: {
      if (!playerId) break;
      const pl = player(state, playerId);
      for (const [k, v] of Object.entries(p)) {
        if (k === "player" || k === "previous") continue;
        if (k === "health" || k === "shield" || k === "score") pl[k] = num(v) ?? pl[k] ?? 0;
        else if (k === "team") pl.team = num(v) ?? pl.team;
        else pl.extra[k] = v;
      }
      break;
    }
    case EventTypes.DeviceStateChanged: {
      const id = str(p["device"]) ?? event.source?.id;
      if (!id) break;
      const d = device(state, id);
      if (typeof p["deviceType"] === "string") d.type = p["deviceType"];
      if (typeof p["state"] === "string") d.state = p["state"];
      if (typeof p["enabled"] === "boolean") d.enabled = p["enabled"];
      if ("owner" in p) {
        const owner = num(p["owner"]);
        if (owner === undefined) delete d.owner;
        else d.owner = owner;
      }
      const progress = num(p["progress"]);
      if (progress !== undefined) d.progress = progress;
      for (const [k, v] of Object.entries(p)) if (!KNOWN_DEVICE_KEYS.has(k)) d.extra[k] = v;
      break;
    }
    case EventTypes.ScoreChanged: {
      const team = num(p["team"]) ?? num(event.target?.id);
      const current = num(p["current"]);
      if (team !== undefined) {
        const key = String(team);
        const t = (state.teams[key] ??= { id: team, score: 0 });
        t.score = current ?? t.score + (num(p["delta"]) ?? 0);
      }
      break;
    }
    case EventTypes.ProbeUpdated: {
      const id = str(p["probe"]);
      if (id) state.probes[id] = p["value"];
      break;
    }
  }
  return state;
}

/** Time-travel view (spec §19): the recorded state as of `timestamp`. */
export function stateAt(events: readonly RuntimeEvent[], timestamp: number): GameState {
  const state = emptyGameState();
  for (const e of events) {
    if (e.timestamp > timestamp) break;
    applyEvent(state, e);
  }
  return state;
}
