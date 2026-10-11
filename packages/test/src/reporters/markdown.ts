import type { RunSummary, TestResult } from "@uefn-devtools/protocol";
import { failureDetail, failingAttempts, isFlaky, percent, totalDurationMs } from "./detail.ts";

/** Hidden marker so a workflow can find and update its own PR comment. */
export const COMMENT_MARKER = "<!-- uefn-devtools-summary -->";

export interface MarkdownOptions {
  /** Link to the workflow run, where uploaded artifacts live. */
  runUrl?: string;
  /** Prepend the PR comment marker. */
  marker?: boolean;
}

/** Escapes text for a Markdown table cell. */
export function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const STATUS_GLYPH: Record<string, string> = { passed: "✓", failed: "✗", error: "✗", skipped: "-" };

function artifactCell(test: TestResult, summary: RunSummary): string {
  const dirs = [...new Set(failingAttempts(test).map((a) => a.artifactDir).filter((d): d is string => !!d))];
  if (dirs.length === 0) return summary.artifactDir && (test.status === "failed" || test.status === "error") ? `\`${summary.artifactDir}\`` : "";
  const shown = dirs.slice(0, 3).map((d) => `\`${d}\``);
  if (dirs.length > 3) shown.push(`+${dirs.length - 3} more`);
  return shown.join("<br>");
}

/** Markdown job summary, also suitable as a PR comment body. */
export function renderMarkdown(summary: RunSummary, options: MarkdownOptions = {}): string {
  const out: string[] = [];
  if (options.marker) out.push(COMMENT_MARKER);
  const glyph = summary.status === "passed" ? "✓" : "✗";
  out.push(`## ${glyph} UEFN DevTools: ${summary.status}`, "");

  const counted = summary.tests.filter((t) => t.status !== "skipped");
  const passed = counted.filter((t) => t.status === "passed").length;
  const failed = counted.length - passed;
  const skipped = summary.tests.length - counted.length;
  const facts = [
    `${passed} passed`,
    ...(failed ? [`${failed} failed`] : []),
    ...(skipped ? [`${skipped} skipped`] : []),
    `${(summary.durationMs / 1000).toFixed(2)}s`,
  ];
  out.push(facts.join(", "), "");

  if (summary.status === "error") {
    out.push(`**Error during ${summary.failedStage ?? "run"}**`, "", "```", summary.error ?? "run failed", "```", "");
  }

  if (summary.tests.length > 0) {
    out.push("| Test | Status | Reliability | Duration | Correlations | Artifacts |", "| --- | --- | --- | --- | --- | --- |");
    for (const t of summary.tests) {
      const flaky = isFlaky(t) ? " (flaky)" : "";
      const reliability = t.attempts.length > 1 ? `${percent(t.reliability)} (${t.passed}/${t.attempts.length})` : t.status === "skipped" ? "" : percent(t.reliability);
      out.push(
        `| ${escapeCell(t.name)} | ${STATUS_GLYPH[t.status] ?? ""} ${t.status}${flaky} | ${reliability} | ${(totalDurationMs(t) / 1000).toFixed(2)}s | ${escapeCell(t.correlations.map((c) => c.description).join("; "))} | ${artifactCell(t, summary)} |`,
      );
    }
    out.push("");
  }

  const failures = summary.tests.filter((t) => failingAttempts(t).length > 0);
  if (failures.length > 0) {
    out.push("### Failures", "");
    for (const t of failures) {
      const first = failingAttempts(t)[0]!;
      const d = failureDetail(first);
      const n = failingAttempts(t).length;
      out.push(`- **${t.name}** (\`${t.file}\`)${n > 1 ? `: ${n} of ${t.attempts.length} attempts failed` : ""}`);
      out.push(`  - ${d.subject ? `${d.subject}: ` : ""}${d.message}${d.failedStage ? ` (stage ${d.failedStage})` : ""}`);
    }
    out.push("");
  }

  if (summary.artifactDir) {
    out.push(
      options.runUrl
        ? `Artifacts: \`${summary.artifactDir}\`, uploaded with the [workflow run](${options.runUrl}).`
        : `Artifacts: \`${summary.artifactDir}\``,
      "",
    );
  }
  return out.join("\n");
}
