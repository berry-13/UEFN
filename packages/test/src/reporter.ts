import type { RunSummary, TestAttempt } from "@uefn-devtools/protocol";
import type { RunnerEvent } from "./runner.ts";

export interface ReporterOptions {
  write?: (text: string) => void;
  color?: boolean;
  verbose?: boolean;
}

/** Human-readable console reporter (spec §70 output shape). */
export function consoleReporter(options: ReporterOptions = {}): (event: RunnerEvent) => void {
  const write = options.write ?? ((t: string) => process.stdout.write(t));
  const color = options.color ?? (process.stdout.isTTY === true && !process.env["NO_COLOR"]);
  const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const green = paint(32);
  const red = paint(31);
  const dim = paint(2);
  const bold = paint(1);
  const yellow = paint(33);
  const line = (s = "") => write(s + "\n");

  const describeAttempt = (attempt: TestAttempt) => {
    const items = [
      ...attempt.steps.map((s) => ({ at: s.timestamp, passed: s.passed, text: s.description, error: s.error })),
      ...attempt.assertions.map((a) => ({
        at: a.timestamp,
        passed: a.passed,
        text: a.description,
        error: a.passed ? undefined : a.message ?? `expected ${JSON.stringify(a.expected)}, received ${JSON.stringify(a.received)}`,
      })),
    ].sort((a, b) => a.at - b.at);
    for (const item of items) {
      line(`${item.passed ? green("✓") : red("✗")} ${item.text}`);
      if (!item.passed && item.error) line(dim(`    ${item.error}`));
    }
    if (attempt.error && !items.some((i) => !i.passed)) line(red(`✗ ${attempt.error}`));
  };

  return (event) => {
    switch (event.kind) {
      case "stage":
        if (event.stage === "BUILDING") line("Compiling Verse...");
        if (event.stage === "STARTING_SESSION") line("Starting UEFN session...");
        if (event.stage === "WAITING_FOR_RUNTIME") line("Waiting for runtime...");
        break;
      case "discovered":
        for (const e of event.errors) line(red(`✗ ${e.file}: ${e.message}`));
        break;
      case "session":
        line(event.reused ? "Reusing session." : "Connected.");
        break;
      case "attempt":
        if (event.repeat === 1) {
          line("");
          line("Running:");
          line(bold(event.test.name));
          line("");
          describeAttempt(event.attempt);
          line("");
          line(event.attempt.status === "passed" ? green(bold("PASS")) : red(bold("FAIL")));
          if (event.attempt.artifactDir) line(dim(`Artifacts: ${event.attempt.artifactDir}`));
        } else if (options.verbose || event.attempt.status !== "passed") {
          line(`${event.attempt.status === "passed" ? green("✓") : red("✗")} ${event.test.name} #${event.attempt.iteration + 1}` +
            (event.attempt.error ? dim(` — ${event.attempt.error}`) : ""));
        }
        break;
      case "test": {
        const r = event.result;
        if (r.status === "skipped") {
          line(yellow(`- ${r.name} (skipped)`));
          break;
        }
        if (r.attempts.length > 1) {
          line("");
          line(bold(r.name));
          line("");
          line(`PASS ${r.passed}`);
          line(`FAIL ${r.failed}`);
          line("");
          line(`Reliability ${Math.round(r.reliability * 1000) / 10}%`);
          if (r.correlations.length > 0) {
            line("");
            line("Failure correlation:");
            for (const c of r.correlations) line(`  ${c.description}`);
          }
        }
        break;
      }
      case "done":
        printSummary(event.summary, line, { green, red, dim, bold });
        break;
    }
  };
}

function printSummary(
  summary: RunSummary,
  line: (s?: string) => void,
  c: Record<"green" | "red" | "dim" | "bold", (s: string) => string>,
): void {
  line("");
  if (summary.status === "error") {
    line(c.red(c.bold(`ERROR during ${summary.failedStage ?? "run"}`)));
    if (summary.error) line(summary.error);
  } else if (summary.tests.length > 1) {
    const passed = summary.tests.filter((t) => t.status === "passed").length;
    const failed = summary.tests.filter((t) => t.status === "failed" || t.status === "error").length;
    line(`${c.bold("Tests")} ${c.green(`${passed} passed`)}${failed ? `, ${c.red(`${failed} failed`)}` : ""}`);
  }
  line(`Duration: ${(summary.durationMs / 1000).toFixed(2)}s`);
  if (summary.artifactDir) line(c.dim(`Results: ${summary.artifactDir}`));
}
