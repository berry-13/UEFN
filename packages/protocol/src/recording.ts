import { z } from "zod";
import { RuntimeEvent } from "./events.ts";
import { GitInfo } from "./session.ts";

export const RecordingKind = z.enum(["scenario", "bug"]);
export type RecordingKind = z.infer<typeof RecordingKind>;

export const Anomaly = z.object({
  rule: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  eventIds: z.array(z.string()),
  traceIds: z.array(z.string()),
});
export type Anomaly = z.infer<typeof Anomaly>;

/**
 * A captured window of runtime events (spec §21). Self-contained: it can be
 * attached to an issue or an agent prompt without the project.
 */
export const Recording = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  kind: RecordingKind,
  project: z.string(),
  adapter: z.string(),
  /** Wall-clock start, epoch milliseconds. */
  startedAt: z.number(),
  /** Session-clock timestamp of the first moment recorded. */
  sessionStart: z.number(),
  durationMs: z.number(),
  git: GitInfo.optional(),
  /** Session the recording belongs to; a recording never spans sessions. */
  sessionId: z.string().optional(),
  /**
   * Derived GameState when recording started, so a recording that begins
   * mid-game can reconstruct who was already playing (teams, positions).
   */
  initialState: z.record(z.string(), z.unknown()).optional(),
  events: z.array(RuntimeEvent),
});
export type Recording = z.infer<typeof Recording>;

export interface RecordingSummary {
  id: string;
  name: string;
  kind: RecordingKind;
  startedAt: number;
  durationMs: number;
  events: number;
  eventTypes: Record<string, number>;
  devices: string[];
  players: string[];
  traces: string[];
  anomalies: Anomaly[];
}
