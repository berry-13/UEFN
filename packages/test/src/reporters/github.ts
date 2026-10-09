import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { RunSummary, TestResult } from "@uefn-devtools/protocol";
import type { RunnerEvent } from "../runner.ts";
import { failureDetail, failingAttempts, isFlaky, percent } from "./detail.ts";
import { renderMarkdown } from "./markdown.ts";

/** Escapes the message part of a workflow command. */
export function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escapes a workflow command property value. */
export function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export interface AnnotationLocation {
  file?: string;
  line?: number;
}

export function workflowCommand(
  command: "error" | "warning" | "notice",
  message: string,
  props: AnnotationLocation & { title?: string } = {},
): string {
  const parts: string[] = [];
  if (props.file) parts.push(`file=${escapeProperty(props.file)}`);
  if (props.line) parts.push(`line=${props.line}`);
  if (props.title) parts.push(`title=${escapeProperty(props.title)}`);
  return `::${command}${parts.length ? " " + parts.join(",") : ""}::${escapeData(message)}`;
}

export interface GithubOptions {
  /** Project root; the summary's file paths are relative to it. */
  root?: string;
  /** Repository root (GITHUB_WORKSPACE), so annotations resolve from the repo root. */
  workspace?: string;
  runUrl?: string;
}

/** Line of the `name:` key in a YAML test document, or undefined. */
function yamlNameLine(absFile: string): number | undefined {
  if (!/\.ya?ml$/i.test(absFile)) return undefined;
  try {
    const index = readFileSync(absFile, "utf8").split(/\r?\n/).findIndex((l) => /^name\s*:/.test(l));
    return index >= 0 ? index + 1 : undefined;
  } catch {
    return undefined;
  }
}

function locate(test: TestResult, options: GithubOptions): AnnotationLocation {
  const root = options.root ?? process.cwd();
  const abs = resolve(root, test.file);
  const file = relative(options.workspace ?? root, abs).split(sep).join("/");
  const line = yamlNameLine(abs);
  return { file, ...(line ? { line } : {}) };
}

/** Workflow commands for a run: errors for failures, notices for flaky tests. */
export function renderAnnotations(summary: RunSummary, options: GithubOptions = {}): string[] {
  const lines: string[] = [];
  for (const test of summary.tests) {
    const failing = failingAttempts(test);
    if (failing.length === 0) continue;
    const d = failureDetail(failing[0]!);
    const where = d.subject ? `${d.subject}: ${d.message}` : d.message;
    const count = test.attempts.length > 1 ? ` (${failing.length} of ${test.attempts.length} attempts failed)` : "";
    const stage = d.failedStage ? ` [stage ${d.failedStage}]` : "";
    lines.push(
      workflowCommand("error", `${where}${stage}${count}`, {
        ...locate(test, options),
        title: `UEFN test failed: ${test.name}`,
      }),
    );
    if (isFlaky(test)) {
      lines.push(
        workflowCommand("notice", `Flaky: passed ${test.passed} of ${test.attempts.length} attempts (reliability ${percent(test.reliability)})`, {
          ...locate(test, options),
          title: `UEFN flaky test: ${test.name}`,
        }),
      );
    }
  }
  if (summary.status === "error") {
    lines.push(workflowCommand("error", summary.error ?? "run failed", { title: `UEFN run error${summary.failedStage ? ` (${summary.failedStage})` : ""}` }));
  }
  return lines;
}

const MAX_LOGGED_ATTEMPTS = 5;

/** Log output: a collapsible group per test (body inside stop-commands), then the annotations. */
export function renderGithubLog(summary: RunSummary, options: GithubOptions = {}): string[] {
  const lines: string[] = [];
  for (const test of summary.tests) {
    lines.push(`::group::${escapeData(`${test.status === "passed" ? "PASS" : test.status === "skipped" ? "SKIP" : "FAIL"} ${test.name}`)}`);
    // Everything free-form below is untrusted (error text, file names): stop command processing for it.
    const token = randomUUID();
    lines.push(`::stop-commands::${token}`);
    lines.push(`file: ${test.file}`);
    if (test.attempts.length > 1) lines.push(`reliability: ${percent(test.reliability)} (${test.passed}/${test.attempts.length})`);
    const failing = failingAttempts(test);
    for (const a of failing.slice(0, MAX_LOGGED_ATTEMPTS)) {
      const d = failureDetail(a);
      lines.push(`#${a.iteration + 1} ${a.status}: ${d.subject ? `${d.subject}: ` : ""}${d.message}`);
      if (a.artifactDir) lines.push(`  artifacts: ${a.artifactDir}`);
    }
    if (failing.length > MAX_LOGGED_ATTEMPTS) lines.push(`... and ${failing.length - MAX_LOGGED_ATTEMPTS} more failing attempts`);
    for (const c of test.correlations) lines.push(`correlation: ${c.description}`);
    lines.push(`::${token}::`);
    lines.push("::endgroup::");
  }
  lines.push(...renderAnnotations(summary, options));
  return lines;
}

/**
 * Prints annotations and, when `$GITHUB_STEP_SUMMARY` names a file, appends the
 * Markdown summary to it.
 */
export function githubReporter(
  options: GithubOptions & { write?: (text: string) => void; summaryFile?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const env = options.env ?? process.env;
  const write = options.write ?? ((t: string) => process.stdout.write(t));
  return (event: RunnerEvent): void => {
    if (event.kind !== "done") return;
    const workspace = options.workspace ?? env["GITHUB_WORKSPACE"];
    const runUrl =
      options.runUrl ??
      (env["GITHUB_SERVER_URL"] && env["GITHUB_REPOSITORY"] && env["GITHUB_RUN_ID"]
        ? `${env["GITHUB_SERVER_URL"]}/${env["GITHUB_REPOSITORY"]}/actions/runs/${env["GITHUB_RUN_ID"]}`
        : undefined);
    const opts: GithubOptions = { ...(options.root ? { root: options.root } : {}), ...(workspace ? { workspace } : {}), ...(runUrl ? { runUrl } : {}) };
    for (const l of renderGithubLog(event.summary, opts)) write(l + "\n");
    const summaryFile = options.summaryFile ?? env["GITHUB_STEP_SUMMARY"];
    if (summaryFile) appendFileSync(summaryFile, renderMarkdown(event.summary, runUrl ? { runUrl } : {}) + "\n");
  };
}
