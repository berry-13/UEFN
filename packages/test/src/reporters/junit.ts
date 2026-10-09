import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RunSummary, TestAttempt } from "@uefn-devtools/protocol";
import type { RunnerEvent } from "../runner.ts";
import { failureDetail, isFailing, totalDurationMs } from "./detail.ts";

export const DEFAULT_JUNIT_PATH = ".devtools/results/junit.xml";

/** Escapes text for XML attribute and element content; drops characters XML 1.0 forbids. */
export function escapeXml(text: string): string {
  return text
    .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const seconds = (ms: number) => (Math.round(ms) / 1000).toFixed(3);

/**
 * JUnit XML for a run. One `<testsuite>` per test; every `--repeat` iteration is a
 * `<testcase>` named `<name> #<n>`, with reliability recorded as suite properties.
 * Output depends only on the summary, so it is deterministic.
 */
export function renderJunit(summary: RunSummary): string {
  const suites: string[][] = [];
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;

  for (const test of summary.tests) {
    const cases: string[] = [];
    let sFail = 0;
    let sErr = 0;
    let sSkip = 0;
    if (test.status === "skipped") {
      cases.push(
        `    <testcase name="${escapeXml(test.name)}" classname="${escapeXml(test.file)}" time="0.000">\n      <skipped/>\n    </testcase>`,
      );
      sSkip++;
    }
    for (const attempt of test.attempts) {
      const name = test.attempts.length > 1 ? `${test.name} #${attempt.iteration + 1}` : test.name;
      const open = `    <testcase name="${escapeXml(name)}" classname="${escapeXml(test.file)}" time="${seconds(attempt.durationMs)}"`;
      if (attempt.status === "passed") {
        cases.push(`${open}/>`);
      } else if (attempt.status === "skipped") {
        sSkip++;
        cases.push(`${open}>\n      <skipped/>\n    </testcase>`);
      } else {
        const isError = attempt.status === "error";
        if (isError) sErr++;
        else sFail++;
        cases.push(`${open}>\n${failureElement(attempt, isError)}\n${systemOut(attempt)}    </testcase>`);
      }
    }
    const props: [string, string][] = [
      ["file", test.file],
      ["reliability", String(Math.round(test.reliability * 1000) / 1000)],
      ["attempts", String(test.attempts.length)],
      ["passed", String(test.passed)],
      ["failed", String(test.failed)],
      ...test.correlations.map((c): [string, string] => ["correlation", c.description]),
    ];
    suites.push([
      `  <testsuite name="${escapeXml(test.name)}" tests="${cases.length}" failures="${sFail}" errors="${sErr}" skipped="${sSkip}" time="${seconds(totalDurationMs(test))}">`,
      "    <properties>",
      ...props.map(([n, v]) => `      <property name="${n}" value="${escapeXml(v)}"/>`),
      "    </properties>",
      ...cases,
      "  </testsuite>",
    ]);
    tests += cases.length;
    failures += sFail;
    errors += sErr;
    skipped += sSkip;
  }

  if (summary.status === "error") {
    const stage = summary.failedStage ?? "RUN";
    const message = summary.error ?? "run failed";
    suites.push([
      `  <testsuite name="uefn-devtools run" tests="1" failures="0" errors="1" skipped="0" time="0.000">`,
      `    <testcase name="${escapeXml(stage)}" classname="uefn-devtools" time="0.000">`,
      `      <error message="${escapeXml(message)}" type="${escapeXml(stage)}">${escapeXml(`Failed stage: ${stage}\n${message}`)}</error>`,
      "    </testcase>",
      "  </testsuite>",
    ]);
    tests++;
    errors++;
  }

  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="uefn-devtools" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${seconds(summary.durationMs)}">`,
  ];
  for (const s of suites) out.push(...s);
  out.push("</testsuites>");
  return out.join("\n") + "\n";
}

function failureElement(attempt: TestAttempt, isError: boolean): string {
  const d = failureDetail(attempt);
  const tag = isError ? "error" : "failure";
  const type = d.failedStage ?? (isError ? "Error" : "AssertionFailure");
  const body = [
    ...(d.subject ? [`Failed: ${d.subject}`] : []),
    d.message,
    ...(d.failedStage ? [`Failed stage: ${d.failedStage}`] : []),
    ...(attempt.artifactDir ? [`Artifacts: ${attempt.artifactDir}`] : []),
  ].join("\n");
  return `      <${tag} message="${escapeXml(d.message)}" type="${escapeXml(type)}">${escapeXml(body)}</${tag}>`;
}

function systemOut(attempt: TestAttempt): string {
  if (!isFailing(attempt.status) || attempt.assertions.length + attempt.steps.length === 0) return "";
  const lines = [
    ...attempt.steps.map((s) => `${s.passed ? "PASS" : "FAIL"} step: ${s.description}`),
    ...attempt.assertions.map((a) => `${a.passed ? "PASS" : "FAIL"} assert: ${a.description}`),
  ];
  return `      <system-out>${escapeXml(lines.join("\n"))}</system-out>\n`;
}

/** Writes JUnit XML to `file` (relative to `cwd`) once the run finishes. */
export function junitReporter(options: { file?: string; cwd?: string; onWrite?: (file: string) => void } = {}) {
  return (event: RunnerEvent): void => {
    if (event.kind !== "done") return;
    const file = options.file ?? DEFAULT_JUNIT_PATH;
    const path = resolve(options.cwd ?? process.cwd(), file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderJunit(event.summary));
    options.onWrite?.(file);
  };
}
