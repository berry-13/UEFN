import { z } from "zod";

/** A reference to anything observable in a UEFN project or session (spec §54). */
export const EntityKind = z.enum(["player", "device", "team", "scene", "verse", "asset", "probe", "system"]);
export type EntityKind = z.infer<typeof EntityKind>;

export const EntityReference = z.object({
  type: EntityKind,
  id: z.string(),
});
export type EntityReference = z.infer<typeof EntityReference>;

/**
 * Every runtime observation normalises into this structure (spec §52),
 * regardless of which transport produced it.
 */
export const RuntimeEvent = z.object({
  id: z.string(),
  /** Milliseconds on the session clock. */
  timestamp: z.number(),
  /** Dotted, lower-case event type, e.g. `score.changed`. */
  type: z.string(),
  source: EntityReference.optional(),
  target: EntityReference.optional(),
  traceId: z.string().optional(),
  parentEventId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type RuntimeEvent = z.infer<typeof RuntimeEvent>;

export const Trace = z.object({
  id: z.string(),
  rootEvent: z.string(),
  events: z.array(z.string()),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum(["running", "completed", "failed"]),
});
export type Trace = z.infer<typeof Trace>;

/**
 * Canonical event types. Transports may emit others; these are the ones the
 * state model and built-in assertions understand.
 */
export const EventTypes = {
  SessionReady: "session.ready",
  GameStarted: "game.started",
  GameEnded: "game.ended",
  PlayerSpawned: "player.spawned",
  PlayerMoved: "player.moved",
  PlayerEnteredArea: "player.entered_area",
  PlayerExitedArea: "player.exited_area",
  PlayerEliminated: "player.eliminated",
  PlayerStateChanged: "player.state_changed",
  DeviceStateChanged: "device.state_changed",
  CaptureStarted: "capture.started",
  CaptureCompleted: "capture.completed",
  ScoreChanged: "score.changed",
  ProbeUpdated: "probe.updated",
  Log: "log",
} as const;
export type CanonicalEventType = (typeof EventTypes)[keyof typeof EventTypes];
