import { z } from "zod";

export const GitInfo = z.object({
  commit: z.string().optional(),
  branch: z.string().optional(),
  dirty: z.boolean(),
  changedFiles: z.array(z.string()),
});
export type GitInfo = z.infer<typeof GitInfo>;

export const SessionStatus = z.enum(["starting", "connected", "playing", "stopped", "failed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Spec §56. */
export const Session = z.object({
  id: z.string(),
  projectId: z.string(),
  status: SessionStatus,
  startedAt: z.number(),
  endedAt: z.number().optional(),
  buildRevision: z.string().optional(),
  gitCommit: z.string().optional(),
  git: GitInfo.optional(),
  adapter: z.string(),
});
export type Session = z.infer<typeof Session>;
