import { z } from "zod";

/** Observable runtime value types (spec §12). */
export const ProbeType = z.enum([
  "bool",
  "int",
  "float",
  "string",
  "vector",
  "rotation",
  "enum",
  "entity",
  "player",
  "device",
  "object",
]);
export type ProbeType = z.infer<typeof ProbeType>;

export const ProbeDefinition = z.object({
  id: z.string(),
  type: ProbeType,
  description: z.string().optional(),
});
export type ProbeDefinition = z.infer<typeof ProbeDefinition>;

export const ProbeSample = z.object({
  value: z.unknown(),
  timestamp: z.number(),
  eventId: z.string().optional(),
});
export type ProbeSample = z.infer<typeof ProbeSample>;

export const Probe = ProbeDefinition.extend({
  current: ProbeSample.optional(),
});
export type Probe = z.infer<typeof Probe>;
