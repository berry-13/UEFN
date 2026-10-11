import { int, openEngine, print, str, UsageError, type Command } from "../shared.ts";

function when(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export const history: Command = {
  name: "history",
  usage: "history [test-id]",
  summary: "Recent runs, or one test's pass/fail history, from the SQLite store",
  options: { sessions: { type: "boolean" }, limit: { type: "string" } },
  optionHelp: [
    "--sessions             List recorded sessions instead of runs",
    "--limit <n>            Rows to show (default 20)",
  ],
  async run(values, positionals) {
    const limit = int(str(values, "limit"), "limit") ?? 20;
    const engine = await openEngine(values);
    const db = engine.db;
    if (!db) throw new UsageError("persistence is disabled (persistence.enabled: false)");
    try {
      const testId = positionals[0];
      if (values.sessions) {
        const sessions = db.listSessions({ limit });
        print(values, sessions, () => {
          if (sessions.length === 0) console.log("no sessions recorded");
          for (const s of sessions) {
            const dur = s.endedAt ? `${((s.endedAt - s.startedAt) / 1000).toFixed(1)}s` : "-";
            console.log(`${s.id.padEnd(24)} ${when(s.startedAt)}  ${s.status.padEnd(9)} ${dur.padStart(7)}  ${s.adapter}  ${s.gitCommit?.slice(0, 8) ?? "-"}`);
          }
        });
        return 0;
      }
      if (testId) {
        const h = db.testHistory(testId, { limit });
        if (h.runs === 0) {
          console.error(`no recorded runs for test '${testId}'`);
          return 2;
        }
        print(values, h, () => {
          console.log(`${h.testId}: ${h.runs} run(s), fail rate ${pct(h.failRate)}, flaky ${pct(h.flakinessRate)}, ${h.flips} flip(s)`);
          for (const e of h.entries) {
            console.log(
              `${when(e.startedAt)}  ${e.status.padEnd(7)} reliability ${pct(e.reliability).padStart(4)} (${e.passed} pass, ${e.failed} fail)  ${e.gitCommit?.slice(0, 8) ?? "-"}  ${e.runId}`,
            );
          }
          // Oldest to newest, one mark per run.
          console.log(`trend (old to new): ${[...h.entries].reverse().map((e) => (e.status === "passed" ? (e.reliability < 1 ? "~" : "+") : "x")).join("")}`);
        });
        return 0;
      }
      const runs = db.listRuns({ limit });
      print(values, runs, () => {
        if (runs.length === 0) console.log("no runs recorded");
        for (const r of runs) {
          const tests = `${r.testsTotal - r.testsFailed}/${r.testsTotal}`;
          console.log(
            `${r.runId.padEnd(14)} ${when(r.startedAt)}  ${r.status.padEnd(6)} ${tests.padStart(5)} tests  ${(r.durationMs / 1000).toFixed(1).padStart(6)}s  ${r.gitCommit?.slice(0, 8) ?? "-"}${r.gitBranch ? ` (${r.gitBranch})` : ""}`,
          );
        }
      });
      return 0;
    } finally {
      await engine.close();
    }
  },
};
