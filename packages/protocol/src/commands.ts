import { z } from "zod";

/**
 * Commands DevTools asks the runtime to perform. Whether a transport can
 * honour a command is a capability question (see docs/capabilities.md).
 */
export const RuntimeCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start_game") }),
  z.object({ type: z.literal("end_game") }),
  z.object({ type: z.literal("reset") }),
  z.object({ type: z.literal("spawn_player"), player: z.string(), team: z.number().int().optional() }),
  z.object({ type: z.literal("teleport"), player: z.string(), location: z.string() }),
  z.object({ type: z.literal("leave_area"), player: z.string(), area: z.string() }),
  z.object({ type: z.literal("eliminate_player"), player: z.string(), by: z.string().optional() }),
  z.object({ type: z.literal("damage_player"), player: z.string(), amount: z.number() }),
  z.object({ type: z.literal("set_device_enabled"), device: z.string(), enabled: z.boolean() }),
  z.object({ type: z.literal("seed"), seed: z.number().int() }),
]);
export type RuntimeCommand = z.infer<typeof RuntimeCommand>;

export interface CommandResult {
  ok: boolean;
  error?: string;
  /** True when the transport cannot perform this command at all. */
  unsupported?: boolean;
  /** True when the runtime was already in the requested state, so nothing happened (no event follows). */
  noop?: boolean;
  data?: unknown;
}
