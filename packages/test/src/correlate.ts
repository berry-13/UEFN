import type { Correlation, TestAttempt } from "@uefn-devtools/protocol";

/**
 * Deterministic failure correlation for repeated runs (spec §25): finds
 * event types whose occurrence count separates every failing attempt from
 * every passing one.
 */
export function correlateFailures(attempts: readonly TestAttempt[]): Correlation[] {
  const failing = attempts.filter((a) => a.status !== "passed");
  const passing = attempts.filter((a) => a.status === "passed");
  if (failing.length === 0 || passing.length === 0) return [];

  const types = new Set<string>();
  for (const a of attempts) for (const t of Object.keys(a.eventCounts)) types.add(t);

  const out: (Correlation & { strength: number })[] = [];
  for (const type of [...types].sort()) {
    const f = failing.map((a) => a.eventCounts[type] ?? 0);
    const p = passing.map((a) => a.eventCounts[type] ?? 0);
    const fMin = Math.min(...f);
    const fMax = Math.max(...f);
    const pMin = Math.min(...p);
    const pMax = Math.max(...p);
    const range = (lo: number, hi: number) => (lo === hi ? `${lo}×` : `${lo}–${hi}×`);
    if (fMin > pMax) {
      out.push({
        description: `${type} occurred ${range(fMin, fMax)} in every failing run vs ${range(pMin, pMax)} in passing runs`,
        failingRuns: failing.length,
        passingRuns: passing.length,
        strength: fMin - pMax,
      });
    } else if (fMax < pMin) {
      out.push({
        description: `${type} occurred ${range(fMin, fMax)} in every failing run vs ${range(pMin, pMax)} in passing runs`,
        failingRuns: failing.length,
        passingRuns: passing.length,
        strength: pMin - fMax,
      });
    }
  }
  return out
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 5)
    .map(({ strength: _strength, ...c }) => c);
}
