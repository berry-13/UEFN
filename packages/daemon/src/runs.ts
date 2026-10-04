import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunSummary } from "@uefn-devtools/protocol";

/** Run history lives on disk as `<results>/<date>/<runId>/summary.json`; this reads it back. */
export async function listRunSummaries(resultsDir: string, limit: number): Promise<RunSummary[]> {
  const dates = (await readdir(resultsDir).catch(() => [] as string[])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  const out: RunSummary[] = [];
  for (const date of dates) {
    const runs = await readdir(join(resultsDir, date)).catch(() => [] as string[]);
    const summaries = await Promise.all(runs.map((run) => readSummary(join(resultsDir, date, run))));
    for (const s of summaries) if (s) out.push(s);
    // Dates are visited newest first, so once we have enough we can stop.
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

export async function findRunSummary(resultsDir: string, runId: string): Promise<RunSummary | undefined> {
  if (!/^run_[a-z0-9]+$/.test(runId)) return undefined;
  const dates = await readdir(resultsDir).catch(() => [] as string[]);
  for (const date of dates.sort().reverse()) {
    const summary = await readSummary(join(resultsDir, date, runId));
    if (summary) return summary;
  }
  return undefined;
}

async function readSummary(dir: string): Promise<RunSummary | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as RunSummary;
  } catch {
    return undefined;
  }
}
