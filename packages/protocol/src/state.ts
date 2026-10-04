import type { Vector3 } from "./project.ts";

/**
 * The single derived state model every client reads (spec §89). It is
 * rebuilt purely from RuntimeEvents, so recordings can be replayed into it.
 */
export interface PlayerState {
  id: string;
  team?: number;
  alive: boolean;
  health?: number;
  shield?: number;
  position?: Vector3;
  score: number;
  eliminations: number;
  deaths: number;
  /** Device ids of areas the player is currently inside. */
  areas: string[];
  extra: Record<string, unknown>;
}

export interface DeviceState {
  id: string;
  type?: string;
  enabled: boolean;
  state?: string;
  owner?: number;
  progress?: number;
  triggerCount: number;
  extra: Record<string, unknown>;
}

export interface TeamState {
  id: number;
  score: number;
}

export interface GameState {
  phase: "idle" | "playing" | "ended";
  round: number;
  startedAt?: number;
  endedAt?: number;
  winner?: number;
  players: Record<string, PlayerState>;
  devices: Record<string, DeviceState>;
  teams: Record<string, TeamState>;
  probes: Record<string, unknown>;
}

export function emptyGameState(): GameState {
  return { phase: "idle", round: 0, players: {}, devices: {}, teams: {}, probes: {} };
}
