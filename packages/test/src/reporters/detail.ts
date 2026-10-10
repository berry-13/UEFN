import type { TestAttempt, TestResult } from "@uefn-devtools/protocol";

export interface FailureDetail {
  /** One-line message, e.g. `expected 1, received 2`. */
  message: string;
  /** Failed step or assertion description, when there is one. */
  subject?: string;
  failedStage?: string;
}

/** The first failing assertion, step, or attempt error of a non-passing attempt. */
export function failureDetail(attempt: TestAttempt): FailureDetail {
  const base = attempt.failedStage ? { failedStage: attempt.failedStage } : {};
  const assertion = attempt.assertions.find((a) => !a.passed);
  if (assertion) {
    return {
      ...base,
      subject: assertion.description,
      message: assertion.message ?? `expected ${JSON.stringify(assertion.expected)}, received ${JSON.stringify(assertion.received)}`,
    };
  }
  const step = attempt.steps.find((s) => !s.passed);
  if (step) return { ...base, subject: step.description, message: step.error ?? "step failed" };
  return { ...base, message: attempt.error ?? `attempt ${attempt.status}` };
}

export function isFailing(status: string): boolean {
  return status === "failed" || status === "error";
}

export function failingAttempts(test: TestResult): TestAttempt[] {
  return test.attempts.filter((a) => isFailing(a.status));
}

export function totalDurationMs(test: TestResult): number {
  return test.attempts.reduce((sum, a) => sum + a.durationMs, 0);
}

export function percent(reliability: number): string {
  return `${Math.round(reliability * 1000) / 10}%`;
}

/** Flaky means it both passed and failed across attempts. */
export function isFlaky(test: TestResult): boolean {
  return test.reliability > 0 && test.reliability < 1;
}
