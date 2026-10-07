import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { discoverProject, listRecordings, listRunSummaries, type DevToolsEngine, type LoadedConfig } from "@uefn-devtools/core";
import { findTestFiles, loadTests } from "@uefn-devtools/test";
import { duplicateSubscription, loopWithoutSuspension, mixedIndentation, spawnInLoop, subscriptionNeverCancelled, varNeverRead } from "./rules/verse.ts";
import { getPlayersInLoop, highFrequencyPolling, unusedEditable } from "./rules/devices.ts";
import {
  flakyTests,
  lastRunFailed,
  mcpAdapterConfig,
  noTests,
  runtimeNeverReady,
  runtimeNotInstalled,
  testLoadErrors,
  unresolvedBugRecordings,
} from "./rules/project.ts";
import { CATEGORIES, CATEGORY_LABELS, type CategoryScore, type DoctorReport, type Finding, type ProjectContext, type Rule, type Severity } from "./types.ts";
import { scanVerse } from "./verse.ts";

export const BUILTIN_RULES: readonly Rule[] = [
  mixedIndentation,
  loopWithoutSuspension,
  varNeverRead,
  duplicateSubscription,
  subscriptionNeverCancelled,
  spawnInLoop,
  unusedEditable,
  getPlayersInLoop,
  highFrequencyPolling,
  noTests,
  testLoadErrors,
  lastRunFailed,
  flakyTests,
  unresolvedBugRecordings,
  runtimeNotInstalled,
  runtimeNeverReady,
  mcpAdapterConfig,
];

/** Categories DevTools cannot assess without data only a real UEFN install has. */
const NEEDS_UEFN: Partial<Record<(typeof CATEGORIES)[number], string>> = {
  assets: "needs UEFN asset data",
  publish: "needs UEFN validation",
};

const WEIGHT: Record<Severity, number> = { error: 15, warning: 5, info: 1 };
const RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };

export async function buildContext(loaded: LoadedConfig): Promise<ProjectContext> {
  const { root, config } = loaded;
  const project = await discoverProject(loaded);
  const verse = await Promise.all(
    project.verseFiles.map(async (file) => scanVerse(file, await readFile(resolve(root, file), "utf8"))),
  );
  const { tests, errors } = await loadTests(await findTestFiles(resolve(root, config.paths.tests)));
  const [lastRun] = await listRunSummaries(resolve(root, config.paths.results), 1);
  return {
    root,
    config,
    project,
    verse,
    tests: { count: tests.length, errors: errors.map((e) => ({ file: relative(root, e.file), message: e.message })) },
    ...(lastRun ? { lastRun } : {}),
    recordings: await listRecordings(root),
  };
}

export interface DoctorOptions {
  rules?: readonly Rule[];
}

/** Runs every enabled rule (spec §26–27) and scores each category. */
export function runRules(ctx: ProjectContext, options: DoctorOptions = {}): DoctorReport {
  const settings = ctx.config.doctor;
  const rules = options.rules ?? BUILTIN_RULES;
  const findings: Finding[] = [];
  const ruleList: DoctorReport["rules"] = [];
  const lineIgnored = (f: Finding) => {
    if (!f.file || !f.line) return false;
    const file = ctx.verse.find((v) => v.path === f.file);
    const here = file?.lines[f.line - 1];
    const above = file?.lines[f.line - 2];
    return !!(here?.ignores.has(f.ruleId) || above?.ignores.has(f.ruleId) || (above && above.code.trim() === "" && above.ignores.has(f.ruleId)));
  };
  for (const rule of rules) {
    const override = settings.rules[rule.id];
    ruleList.push({ id: rule.id, title: rule.title, category: rule.category, severity: override ?? rule.severity });
    if (override === "off") continue;
    let produced: Finding[];
    try {
      produced = rule.evaluate(ctx);
    } catch (error) {
      produced = [{ ruleId: rule.id, category: rule.category, severity: "error", message: `rule crashed: ${(error as Error).message}` }];
    }
    for (const f of produced) {
      if (lineIgnored(f)) continue;
      findings.push(override ? { ...f, severity: override } : f);
    }
  }
  findings.sort((a, b) => RANK[b.severity] - RANK[a.severity] || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));

  const scores: CategoryScore[] = CATEGORIES.map((category) => {
    const reason = NEEDS_UEFN[category];
    if (reason) return { category, label: CATEGORY_LABELS[category], score: null, reason };
    const penalty = findings.filter((f) => f.category === category).reduce((sum, f) => sum + WEIGHT[f.severity], 0);
    return { category, label: CATEGORY_LABELS[category], score: Math.max(0, 100 - penalty) };
  });
  const counts = { error: 0, warning: 0, info: 0 } as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;
  const failOn = settings.severity.fail_on;
  const failed = failOn !== "never" && findings.some((f) => RANK[f.severity] >= RANK[failOn]);
  return { scores, counts, findings, rules: ruleList, failOn, failed };
}

export async function runDoctor(loaded: LoadedConfig, options: DoctorOptions = {}): Promise<DoctorReport> {
  return runRules(await buildContext(loaded), options);
}

export function runDoctorForEngine(engine: DevToolsEngine, options: DoctorOptions = {}): Promise<DoctorReport> {
  return runDoctor(engine.loaded, options);
}

export function formatReport(report: DoctorReport, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const red = paint(31);
  const yellow = paint(33);
  const dim = paint(2);
  const bold = paint(1);
  const sev = (s: Severity) => (s === "error" ? red("error  ") : s === "warning" ? yellow("warning") : dim("info   "));
  const lines = [bold("UEFN PROJECT HEALTH"), ""];
  for (const s of report.scores) {
    lines.push(`${s.label.padEnd(22)} ${s.score === null ? dim(`n/a  (${s.reason})`) : String(s.score).padStart(3)}`);
  }
  lines.push("", `Critical  ${String(report.counts.error).padStart(4)}`, `Warnings  ${String(report.counts.warning).padStart(4)}`, `Info      ${String(report.counts.info).padStart(4)}`);
  if (report.findings.length) lines.push("");
  for (const f of report.findings) {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "";
    lines.push(`${bold(f.ruleId)}  ${sev(f.severity)}  ${where}`);
    lines.push(`  ${f.message}${f.heuristic ? dim("  (heuristic)") : ""}`);
    for (const d of f.detail ?? []) lines.push(dim(`  ${d}`));
    lines.push("");
  }
  if (!report.findings.length) lines.push("", "No findings.");
  lines.push(dim(`Suppress a finding with "# devtools-ignore <RULE-ID>" on or above its line, or set doctor.rules.<RULE-ID>: off.`));
  return lines.join("\n");
}
