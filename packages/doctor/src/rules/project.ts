import type { Finding, Rule } from "../types.ts";

export const noTests: Rule = {
  id: "UEFN-T401",
  category: "tests",
  severity: "warning",
  title: "No gameplay tests",
  description: "Without tests, no command can tell you whether a change broke gameplay.",
  evaluate: (ctx) =>
    ctx.tests.count === 0 && ctx.tests.errors.length === 0
      ? [{
          ruleId: "UEFN-T401",
          category: "tests" as const,
          severity: "warning" as const,
          message: `No tests found in ${ctx.config.paths.tests}`,
          detail: ["Record one with `uefn record`, or write a *.test.yaml / *.test.ts (docs/tests.md)."],
        }]
      : [],
};

export const testLoadErrors: Rule = {
  id: "UEFN-T402",
  category: "tests",
  severity: "error",
  title: "Test file fails to load",
  description: "A test file that does not parse or validate stops every run in the VALIDATING stage.",
  evaluate: (ctx) =>
    ctx.tests.errors.map((e) => ({
      ruleId: "UEFN-T402",
      category: "tests" as const,
      severity: "error" as const,
      message: e.message.split("\n")[0]!,
      file: e.file,
      detail: e.message.split("\n").slice(1, 6),
    })),
};

export const lastRunFailed: Rule = {
  id: "UEFN-T403",
  category: "tests",
  severity: "warning",
  title: "Most recent test run did not pass",
  description: "The latest run in .devtools/results failed or errored.",
  evaluate(ctx) {
    const run = ctx.lastRun;
    if (!run || run.status === "passed") return [];
    const failed = run.tests.filter((t) => t.status === "failed" || t.status === "error");
    return [{
      ruleId: this.id,
      category: this.category,
      severity: this.severity,
      message:
        run.status === "error"
          ? `Last run (${run.runId}) stopped during ${run.failedStage ?? "the run"}: ${run.error ?? ""}`
          : `Last run (${run.runId}) failed ${failed.length} of ${run.tests.length} test(s)`,
      detail: failed.slice(0, 5).map((t) => `${t.id}: ${t.attempts.find((a) => a.status !== "passed")?.error ?? t.status}`),
    }];
  },
};

export const flakyTests: Rule = {
  id: "UEFN-T404",
  category: "tests",
  severity: "warning",
  title: "Flaky test",
  description: "A repeated test passed some iterations and failed others in the latest run.",
  evaluate(ctx) {
    return (ctx.lastRun?.tests ?? [])
      .filter((t) => t.attempts.length > 1 && t.passed > 0 && t.failed > 0)
      .map((t) => ({
        ruleId: this.id,
        category: this.category,
        severity: this.severity,
        message: `${t.id} is ${Math.round(t.reliability * 100)}% reliable (${t.passed}/${t.attempts.length})`,
        file: t.file,
        detail: t.correlations.map((c) => `Correlation: ${c.description}`),
      }));
  },
};

export const unresolvedBugRecordings: Rule = {
  id: "UEFN-T405",
  category: "tests",
  severity: "info",
  title: "Bug recording with anomalies",
  description: "A bug recording reported anomalies; turn it into a regression test with `uefn generate-test`.",
  evaluate(ctx) {
    return ctx.recordings
      .filter((r) => r.kind === "bug" && r.anomalies.some((a) => a.severity !== "info"))
      .map((r) => ({
        ruleId: this.id,
        category: this.category,
        severity: this.severity,
        message: `Bug recording "${r.name}" (${r.id}) has ${r.anomalies.length} anomal${r.anomalies.length === 1 ? "y" : "ies"}`,
        file: `.devtools/recordings/${r.id}.json`,
        detail: [...r.anomalies.slice(0, 3).map((a) => a.message), `Next: uefn generate-test ${r.id}`],
      }));
  },
};

/** Files that define the DevTools emitter (runtime/verse/devtools.verse). */
function runtimeFiles(ctx: Parameters<Rule["evaluate"]>[0]): string[] {
  return ctx.verse.filter((f) => f.lines.some((l) => /\bdevtools_emitter\s*(<[^>]*>)?\s*:=\s*class\b/.test(l.code))).map((f) => f.path);
}

const RUNTIME_API = /\bdevtools_emitter\b|\bDevTools(String|Int|Float|Bool|Source|Target|Parent|Trace|Escape)\s*\(/;

export const runtimeNotInstalled: Rule = {
  id: "UEFN-S501",
  category: "devtools",
  severity: "warning",
  title: "DevTools Verse runtime not installed",
  description: "Without runtime/verse/devtools.verse in the project, a real session reports no events and tests cannot observe anything.",
  evaluate(ctx) {
    if (runtimeFiles(ctx).length > 0) return [];
    const users = ctx.verse.flatMap((f) => {
      const l = f.lines.find((x) => RUNTIME_API.test(x.code));
      return l ? [{ file: f.path, line: l.number }] : [];
    });
    if (users.length > 0) {
      return [{
        ruleId: this.id,
        category: this.category,
        severity: "error",
        message: "Verse uses the DevTools runtime, but no file defines it",
        ...users[0]!,
        detail: [
          `Used in: ${users.map((u) => `${u.file}:${u.line}`).join(", ")}`,
          "Copy runtime/verse/devtools.verse into the project's Verse folder; without it this Verse does not compile.",
        ],
      }];
    }
    const real = ctx.config.adapter !== "simulated";
    return [{
      ruleId: this.id,
      category: this.category,
      severity: real ? "warning" : "info",
      message: "No Verse file defines devtools_emitter",
      detail: [
        "Copy runtime/verse/devtools.verse into the project's Verse folder.",
        real ? "Required for the mcp adapter: runtime events come from it." : "Not needed for the simulated adapter.",
      ],
    }];
  },
};

export const runtimeNeverReady: Rule = {
  id: "UEFN-S502",
  category: "devtools",
  severity: "warning",
  title: "DevTools runtime never announces itself",
  description: "The runner waits for the emitter's Hello() line before running tests; without it every run times out in WAITING_FOR_RUNTIME.",
  evaluate(ctx) {
    if (runtimeFiles(ctx).length === 0) return [];
    const hello = ctx.verse.some((f) => f.lines.some((l) => /\.Hello\s*\(\s*\)/.test(l.code)));
    return hello
      ? []
      : [{
          ruleId: this.id,
          category: this.category,
          severity: this.severity,
          message: "devtools_emitter is installed but Hello() is never called",
          detail: ["Call DevTools.Hello() in a device's OnBegin."],
        }];
  },
};

export const mcpAdapterConfig: Rule = {
  id: "UEFN-S503",
  category: "devtools",
  severity: "error",
  title: "mcp adapter is not fully configured",
  description: "The mcp adapter needs a server to connect to, tool mappings, and the output log path.",
  evaluate(ctx) {
    const c = ctx.config;
    if (c.adapter !== "mcp") return [];
    const out: Finding[] = [];
    const add = (severity: Finding["severity"], message: string, detail: string) =>
      out.push({ ruleId: this.id, category: this.category, severity, message, file: "uefn-devtools.config.yaml", detail: [detail] });
    if (!c.mcp.command && !c.mcp.url) add("error", "mcp.command or mcp.url is not set", "DevTools cannot reach the UEFN MCP server.");
    if (!c.runtime.log_path) add("error", "runtime.log_path is not set", "Runtime events are read from the UEFN output log.");
    for (const key of ["compile", "start_session"] as const) {
      if (!c.mcp.tools[key]) add("warning", `mcp.tools.${key} is not mapped`, "Run `uefn capabilities --adapter mcp` to list the server's tools.");
    }
    return out;
  },
};
