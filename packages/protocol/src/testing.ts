import { z } from "zod";

/** Formal test-run state machine (spec §8). */
export const RunStage = z.enum([
  "DISCOVERING",
  "VALIDATING",
  "BUILDING",
  "STARTING_SESSION",
  "WAITING_FOR_RUNTIME",
  "INITIALIZING",
  "RUNNING",
  "ASSERTING",
  "COLLECTING",
  "CLEANUP",
  "PASSED",
  "FAILED",
]);
export type RunStage = z.infer<typeof RunStage>;

/** Stages that happen once per `uefn test` invocation. */
export const RUN_LEVEL_STAGES: readonly RunStage[] = [
  "DISCOVERING",
  "VALIDATING",
  "BUILDING",
  "STARTING_SESSION",
  "WAITING_FOR_RUNTIME",
];

export const AssertionResult = z.object({
  description: z.string(),
  passed: z.boolean(),
  expected: z.unknown().optional(),
  received: z.unknown().optional(),
  message: z.string().optional(),
  timestamp: z.number(),
});
export type AssertionResult = z.infer<typeof AssertionResult>;

export const StepResult = z.object({
  description: z.string(),
  passed: z.boolean(),
  durationMs: z.number(),
  timestamp: z.number(),
  error: z.string().optional(),
});
export type StepResult = z.infer<typeof StepResult>;

export const TestStatus = z.enum(["passed", "failed", "error", "skipped"]);
export type TestStatus = z.infer<typeof TestStatus>;

export const TestAttempt = z.object({
  iteration: z.number(),
  status: TestStatus,
  durationMs: z.number(),
  seed: z.number().optional(),
  steps: z.array(StepResult),
  assertions: z.array(AssertionResult),
  error: z.string().optional(),
  failedStage: RunStage.optional(),
  /** Event-type → count, used for failure correlation. */
  eventCounts: z.record(z.string(), z.number()),
  artifactDir: z.string().optional(),
});
export type TestAttempt = z.infer<typeof TestAttempt>;

export const Correlation = z.object({
  description: z.string(),
  failingRuns: z.number(),
  passingRuns: z.number(),
});
export type Correlation = z.infer<typeof Correlation>;

export const TestResult = z.object({
  id: z.string(),
  name: z.string(),
  file: z.string(),
  status: TestStatus,
  attempts: z.array(TestAttempt),
  passed: z.number(),
  failed: z.number(),
  /** passed / attempts, 0..1. */
  reliability: z.number(),
  correlations: z.array(Correlation),
});
export type TestResult = z.infer<typeof TestResult>;

export const RunSummary = z.object({
  runId: z.string(),
  status: z.enum(["passed", "failed", "error"]),
  startedAt: z.number(),
  durationMs: z.number(),
  failedStage: RunStage.optional(),
  error: z.string().optional(),
  tests: z.array(TestResult),
  compile: z
    .object({ success: z.boolean(), durationMs: z.number(), diagnostics: z.number() })
    .optional(),
  sessionId: z.string().optional(),
  artifactDir: z.string().optional(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const TestInfo = z.object({
  id: z.string(),
  name: z.string(),
  file: z.string(),
  format: z.enum(["typescript", "yaml"]),
});
export type TestInfo = z.infer<typeof TestInfo>;
