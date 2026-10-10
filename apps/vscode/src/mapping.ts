import * as path from "node:path";
import type { CompileResult, Diagnostic, ListedTest, RunSummary, TestAttempt, TestResult } from "./types.ts";

export type Outcome = "passed" | "failed" | "errored" | "skipped";

/** A test message before it becomes a `vscode.TestMessage`. */
export interface MappedMessage {
  message: string;
  /** Present for assertion failures; becomes `TestMessage.diff`. */
  expected?: string;
  actual?: string;
}

export interface MappedResult {
  id: string;
  outcome: Outcome;
  durationMs: number;
  messages: MappedMessage[];
  /** Human summary for repeated runs, e.g. `Reliability 89% (89 of 100 passed)`. */
  reliability?: string;
}

/** Renders an assertion value the way it reads best in a diff editor. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function stageSuffix(attempt: TestAttempt): string {
  return attempt.failedStage ? ` (failed in stage ${attempt.failedStage})` : "";
}

/** Messages that explain one failing attempt: failed assertions first, then failed steps, then the error. */
export function attemptMessages(attempt: TestAttempt, prefix = ""): MappedMessage[] {
  const out: MappedMessage[] = [];
  const stage = stageSuffix(attempt);
  for (const a of attempt.assertions) {
    if (a.passed) continue;
    const text = `${prefix}${a.description}${a.message ? `: ${a.message}` : ""}${stage}`;
    if ("expected" in a || "received" in a) {
      out.push({ message: text, expected: formatValue(a.expected), actual: formatValue(a.received) });
    } else {
      out.push({ message: text });
    }
  }
  for (const s of attempt.steps) {
    if (s.passed) continue;
    out.push({ message: `${prefix}Step failed: ${s.description}${s.error ? `: ${s.error}` : ""}${stage}` });
  }
  if (out.length === 0) {
    out.push({ message: `${prefix}${attempt.error ?? `Test ${attempt.status}`}${stage}` });
  } else if (attempt.error && !out.some((m) => m.message.includes(attempt.error!))) {
    out.push({ message: `${prefix}${attempt.error}${stage}` });
  }
  return out;
}

export function reliabilityText(result: TestResult): string {
  const total = result.attempts.length;
  const pct = Math.round(result.reliability * 1000) / 10;
  return `Reliability ${pct}% (${result.passed} of ${total} passed, ${result.failed} failed)`;
}

/** Maps one TestResult from a RunSummary to an outcome, a duration and messages. */
export function mapTestResult(result: TestResult): MappedResult {
  const attempts = result.attempts;
  const durationMs = attempts.reduce((sum, a) => sum + a.durationMs, 0);
  const outcome: Outcome =
    result.status === "passed" ? "passed" : result.status === "skipped" ? "skipped" : result.status === "error" ? "errored" : "failed";
  const mapped: MappedResult = { id: result.id, outcome, durationMs, messages: [] };
  const repeated = attempts.length > 1;
  if (repeated) mapped.reliability = reliabilityText(result);

  if (outcome === "failed" || outcome === "errored") {
    const failing = attempts.filter((a) => a.status === "failed" || a.status === "error");
    const first = failing[0];
    if (first) {
      const prefix = repeated ? `Iteration ${first.iteration + 1}${first.seed !== undefined ? ` (seed ${first.seed})` : ""}: ` : "";
      mapped.messages.push(...attemptMessages(first, prefix));
    } else {
      mapped.messages.push({ message: `Test ${result.status}` });
    }
    if (repeated) {
      const lines = [mapped.reliability!];
      for (const c of result.correlations) {
        lines.push(`${c.description} (failing runs ${c.failingRuns}, passing runs ${c.passingRuns})`);
      }
      mapped.messages.unshift({ message: lines.join("\n") });
    }
  }
  return mapped;
}

/**
 * Maps a RunSummary onto the requested test ids. Requested tests missing from
 * the summary are errored with the run-level error (a VALIDATING, BUILDING or
 * session failure stops the run before any test executes).
 */
export function mapRunSummary(summary: RunSummary, requested: readonly string[]): Map<string, MappedResult> {
  const out = new Map<string, MappedResult>();
  const wanted = new Set(requested);
  for (const result of summary.tests) {
    if (wanted.has(result.id)) out.set(result.id, mapTestResult(result));
  }
  for (const id of requested) {
    if (out.has(id)) continue;
    const stage = summary.failedStage ? ` (failed in stage ${summary.failedStage})` : "";
    const reason = summary.error ?? (summary.status === "passed" ? "Test was not run" : `Run ${summary.status}`);
    out.set(id, { id, outcome: "errored", durationMs: 0, messages: [{ message: `${reason}${stage}` }] });
  }
  return out;
}

/**
 * Decides which `uefn test <filter>` invocations cover `selected`. The CLI
 * filter is a substring match on id, name and file, so a single id can match
 * more tests than asked for; extra results are ignored by mapRunSummary.
 * Selecting every known test needs one unfiltered run.
 */
export function planRuns(selected: readonly string[], all: readonly ListedTest[]): (string | undefined)[] {
  const unique = [...new Set(selected)];
  if (unique.length === 0) return [];
  const allIds = new Set(all.map((t) => t.id));
  if (allIds.size > 0 && allIds.size === unique.length && unique.every((id) => allIds.has(id))) return [undefined];
  return unique;
}

export interface FileGroup {
  file: string;
  tests: ListedTest[];
}

/** Groups listed tests by file, files sorted by path, tests by line then name. */
export function groupByFile(tests: readonly ListedTest[]): FileGroup[] {
  const byFile = new Map<string, ListedTest[]>();
  for (const t of tests) {
    const list = byFile.get(t.file) ?? [];
    list.push(t);
    byFile.set(t.file, list);
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, list]) => ({
      file,
      tests: list.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name)),
    }));
}

export interface MappedDiagnostic {
  /** 0-based. */
  line: number;
  /** 0-based. */
  column: number;
  severity: Diagnostic["severity"];
  message: string;
  code?: string;
}

export interface MappedDiagnostics {
  /** Absolute file path to its diagnostics. */
  byFile: Map<string, MappedDiagnostic[]>;
  /** Diagnostics without a file (shown in the output channel). */
  general: Diagnostic[];
}

/**
 * Groups compile diagnostics by absolute file path. The CLI already returns
 * absolute paths (the engine resolves adapter paths against paths.verse);
 * a relative path from an older CLI resolves against `root`.
 */
export function mapDiagnostics(result: CompileResult, root: string): MappedDiagnostics {
  const byFile = new Map<string, MappedDiagnostic[]>();
  const general: Diagnostic[] = [];
  for (const d of result.diagnostics) {
    if (!d.file) {
      general.push(d);
      continue;
    }
    const file = path.resolve(root, d.file);
    const list = byFile.get(file) ?? [];
    list.push({
      line: Math.max(0, (d.line ?? 1) - 1),
      column: Math.max(0, (d.column ?? 1) - 1),
      severity: d.severity,
      message: d.message,
      ...(d.code ? { code: d.code } : {}),
    });
    byFile.set(file, list);
  }
  return { byFile, general };
}
