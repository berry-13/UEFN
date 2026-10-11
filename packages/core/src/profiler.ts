import type { RuntimeEvent } from "@uefn-devtools/protocol";
import { EventTypes } from "@uefn-devtools/protocol";

/**
 * A runner stage transition. Structurally compatible with the `stage`
 * RunnerEvent of @uefn-devtools/test (which depends on core, so core cannot
 * import it). `at` must be on the same clock as the event timestamps (the
 * session clock) for stages and runtime events to line up in a trace.
 */
export interface StageMark {
  stage: string;
  test?: string;
  iteration?: number;
  at: number;
}

export interface ProfileOptions {
  stages?: readonly StageMark[];
  /** How many hot event types to list (default 10). */
  top?: number;
}

export interface DistributionStats {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface SpanStats {
  name: string;
  count: number;
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface SampleStats {
  /** `<scope>.<metric>`, e.g. `world.frame_ms`. */
  metric: string;
  count: number;
  min: number;
  mean: number;
  p95: number;
  max: number;
}

export interface CausalEdgeStats {
  parentType: string;
  childType: string;
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface TypeThroughput {
  type: string;
  count: number;
  perSecond: number;
  share: number;
}

export interface StageTiming {
  stage: string;
  test?: string;
  iteration?: number;
  startMs: number;
  durationMs: number;
}

export interface Profile {
  session: { startMs: number; endMs: number; durationMs: number; events: number };
  throughput: { eventsPerSecond: number; byType: TypeThroughput[] };
  hotEventTypes: TypeThroughput[];
  spans: SpanStats[];
  samples: SampleStats[];
  causalLatency: CausalEdgeStats[];
  stages?: {
    timings: StageTiming[];
    /** Total time per stage across the run. */
    totals: Record<string, number>;
    /** Per test (and iteration), time per stage. */
    perTest: { test: string; iteration: number; stages: Record<string, number> }[];
  };
}

/** Nearest-rank percentile of an ascending array (p in 0..100). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function distribution(values: readonly number[]): DistributionStats {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    mean: sorted.length ? sum / sorted.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function push<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function spanDuration(e: RuntimeEvent): number | undefined {
  const d = e.payload["duration_ms"];
  return typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : undefined;
}

function spanName(e: RuntimeEvent): string {
  return typeof e.payload["name"] === "string" ? e.payload["name"] : "(unnamed)";
}

/**
 * Aggregates a recorded event stream (and optionally runner stage marks)
 * into a profile. Pure: the same inputs always give the same profile.
 */
export function buildProfile(events: readonly RuntimeEvent[], options: ProfileOptions = {}): Profile {
  let startMs = events.length ? Infinity : 0;
  let endMs = events.length ? -Infinity : 0;
  for (const e of events) {
    if (e.timestamp < startMs) startMs = e.timestamp;
    if (e.timestamp > endMs) endMs = e.timestamp;
  }
  const durationMs = endMs - startMs;
  const seconds = durationMs / 1000;
  const rate = (n: number) => (seconds > 0 ? r3(n / seconds) : 0);

  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const byType: TypeThroughput[] = [...counts.entries()]
    .map(([type, count]) => ({ type, count, perSecond: rate(count), share: r3(count / events.length) }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  const spanDurations = new Map<string, number[]>();
  const sampleValues = new Map<string, number[]>();
  for (const e of events) {
    if (e.type === EventTypes.PerfSpan) {
      const d = spanDuration(e);
      if (d !== undefined) push(spanDurations, spanName(e), d);
    } else if (e.type === EventTypes.PerfSample) {
      const scope = typeof e.payload["scope"] === "string" ? e.payload["scope"] : "runtime";
      for (const [key, value] of Object.entries(e.payload)) {
        if (typeof value === "number" && Number.isFinite(value)) push(sampleValues, `${scope}.${key}`, value);
      }
    }
  }

  const spans: SpanStats[] = [...spanDurations.entries()]
    .map(([name, values]) => {
      const d = distribution(values);
      return {
        name,
        count: d.count,
        totalMs: r3(values.reduce((a, b) => a + b, 0)),
        meanMs: r3(d.mean),
        p50Ms: r3(d.p50),
        p95Ms: r3(d.p95),
        maxMs: r3(d.max),
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name));

  const samples: SampleStats[] = [...sampleValues.entries()]
    .map(([metric, values]) => {
      const d = distribution(values);
      return { metric, count: d.count, min: r3(d.min), mean: r3(d.mean), p95: r3(d.p95), max: r3(d.max) };
    })
    .sort((a, b) => a.metric.localeCompare(b.metric));

  // Causal latency: child timestamp minus parent timestamp, per type edge.
  // perf.* children are measurements of their parent, not effects of it.
  const byId = new Map(events.map((e) => [e.id, e] as const));
  const edges = new Map<string, number[]>();
  for (const e of events) {
    if (!e.parentEventId || e.type.startsWith("perf.")) continue;
    const parent = byId.get(e.parentEventId);
    if (!parent) continue;
    push(edges, `${parent.type}\u0000${e.type}`, Math.max(0, e.timestamp - parent.timestamp));
  }
  const causalLatency: CausalEdgeStats[] = [...edges.entries()]
    .map(([key, values]) => {
      const [parentType, childType] = key.split("\u0000") as [string, string];
      const d = distribution(values);
      return {
        parentType,
        childType,
        count: d.count,
        meanMs: r3(d.mean),
        p50Ms: r3(d.p50),
        p95Ms: r3(d.p95),
        maxMs: r3(d.max),
      };
    })
    .sort((a, b) => b.meanMs - a.meanMs || a.parentType.localeCompare(b.parentType) || a.childType.localeCompare(b.childType));

  const profile: Profile = {
    session: { startMs: r3(startMs), endMs: r3(endMs), durationMs: r3(durationMs), events: events.length },
    throughput: { eventsPerSecond: rate(events.length), byType },
    hotEventTypes: byType.slice(0, options.top ?? 10),
    spans,
    samples,
    causalLatency,
  };
  if (options.stages?.length) profile.stages = stageTimings(options.stages);
  return profile;
}

/** Each stage lasts until the next stage mark. The final mark has no duration. */
function stageTimings(marks: readonly StageMark[]): NonNullable<Profile["stages"]> {
  const timings: StageTiming[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const m = marks[i]!;
    timings.push({
      stage: m.stage,
      ...(m.test !== undefined ? { test: m.test } : {}),
      ...(m.iteration !== undefined ? { iteration: m.iteration } : {}),
      startMs: r3(m.at),
      durationMs: r3(Math.max(0, marks[i + 1]!.at - m.at)),
    });
  }
  const totals: Record<string, number> = {};
  const perTestMap = new Map<string, { test: string; iteration: number; stages: Record<string, number> }>();
  for (const t of timings) {
    totals[t.stage] = r3((totals[t.stage] ?? 0) + t.durationMs);
    if (t.test === undefined) continue;
    const key = `${t.test}#${t.iteration ?? 0}`;
    let entry = perTestMap.get(key);
    if (!entry) {
      entry = { test: t.test, iteration: t.iteration ?? 0, stages: {} };
      perTestMap.set(key, entry);
    }
    entry.stages[t.stage] = r3((entry.stages[t.stage] ?? 0) + t.durationMs);
  }
  return { timings, totals, perTest: [...perTestMap.values()] };
}

// ── exporters ───────────────────────────────────────────────────────────────

function table(headers: string[], rows: (string | number)[][]): string[] {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i]!.length)));
  const fmt = (r: string[]) =>
    r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ").trimEnd();
  return [fmt(headers), widths.map((w) => "-".repeat(w)).join("  "), ...cells.slice(1).map(fmt)];
}

const ms = (n: number) => n.toFixed(3);

/** Plain-text report of a profile, one section per aspect. */
export function formatProfile(profile: Profile): string {
  const out: string[] = [];
  const s = profile.session;
  out.push(
    `Session: ${(s.durationMs / 1000).toFixed(2)}s (session clock), ${s.events} events, ${profile.throughput.eventsPerSecond} events/s`,
  );
  out.push("", "Hot event types");
  out.push(...table(["type", "count", "per s", "share"], profile.hotEventTypes.map((t) => [t.type, t.count, t.perSecond, `${(t.share * 100).toFixed(1)}%`])));
  if (profile.spans.length) {
    out.push("", "Spans (ms)");
    out.push(...table(
      ["name", "count", "total", "mean", "p50", "p95", "max"],
      profile.spans.map((x) => [x.name, x.count, ms(x.totalMs), ms(x.meanMs), ms(x.p50Ms), ms(x.p95Ms), ms(x.maxMs)]),
    ));
  }
  if (profile.samples.length) {
    out.push("", "Samples");
    out.push(...table(
      ["metric", "count", "min", "mean", "p95", "max"],
      profile.samples.map((x) => [x.metric, x.count, x.min, x.mean, x.p95, x.max]),
    ));
  }
  if (profile.causalLatency.length) {
    out.push("", "Causal latency (ms, parent -> child)");
    out.push(...table(
      ["edge", "count", "mean", "p50", "p95", "max"],
      profile.causalLatency.map((x) => [`${x.parentType} -> ${x.childType}`, x.count, ms(x.meanMs), ms(x.p50Ms), ms(x.p95Ms), ms(x.maxMs)]),
    ));
  }
  if (profile.stages) {
    const order = ["DISCOVERING", "VALIDATING", "BUILDING", "STARTING_SESSION", "WAITING_FOR_RUNTIME", "INITIALIZING", "RUNNING", "ASSERTING", "COLLECTING", "CLEANUP"];
    out.push("", "Run stages (ms)");
    out.push(...table(
      ["stage", "total"],
      order.filter((st) => profile.stages!.totals[st] !== undefined).map((st) => [st, ms(profile.stages!.totals[st]!)]),
    ));
    if (profile.stages.perTest.length) {
      const cols = ["RUNNING", "ASSERTING", "CLEANUP"];
      out.push("", "Per test (ms)");
      out.push(...table(
        ["test", ...cols.map((c) => c.toLowerCase())],
        profile.stages.perTest.map((t) => [
          t.iteration > 0 ? `${t.test} #${t.iteration + 1}` : t.test,
          ...cols.map((c) => ms(t.stages[c] ?? 0)),
        ]),
      ));
    }
  }
  return out.join("\n");
}

export interface ChromeTraceEvent {
  name: string;
  ph: "X" | "C" | "i" | "M";
  ts: number;
  pid: number;
  tid: number;
  dur?: number;
  s?: "t" | "p" | "g";
  cat?: string;
  args?: Record<string, unknown>;
}

const PID = 1;
const TID_EVENTS = 1;
const TID_SPANS = 2;
const TID_STAGES = 3;

/**
 * Chrome trace-event JSON (opens in chrome://tracing and ui.perfetto.dev).
 * Timestamps are microseconds on the session clock. Spans and stages are
 * `X` (complete) events, samples are `C` counters, other runtime events are
 * thread-scoped instants.
 */
export function toChromeTrace(
  events: readonly RuntimeEvent[],
  options: { stages?: readonly StageMark[] } = {},
): { traceEvents: ChromeTraceEvent[]; displayTimeUnit: "ms" } {
  const us = (msValue: number) => Math.round(msValue * 1000);
  const trace: ChromeTraceEvent[] = [
    { name: "process_name", ph: "M", ts: 0, pid: PID, tid: 0, args: { name: "UEFN session" } },
    { name: "thread_name", ph: "M", ts: 0, pid: PID, tid: TID_EVENTS, args: { name: "runtime events" } },
    { name: "thread_name", ph: "M", ts: 0, pid: PID, tid: TID_SPANS, args: { name: "spans" } },
  ];
  for (const e of events) {
    if (e.type === EventTypes.PerfSpan) {
      const d = spanDuration(e) ?? 0;
      trace.push({
        name: spanName(e),
        ph: "X",
        cat: "span",
        ts: us(e.timestamp - d),
        dur: us(d),
        pid: PID,
        tid: TID_SPANS,
        args: { id: e.id, ...(e.parentEventId ? { parent: e.parentEventId } : {}), ...e.payload },
      });
    } else if (e.type === EventTypes.PerfSample) {
      const scope = typeof e.payload["scope"] === "string" ? e.payload["scope"] : "runtime";
      const numeric = Object.fromEntries(Object.entries(e.payload).filter(([, v]) => typeof v === "number"));
      // One counter track per metric keeps unrelated units off a shared axis.
      for (const [metric, value] of Object.entries(numeric)) {
        trace.push({ name: `${scope}.${metric}`, ph: "C", cat: "sample", ts: us(e.timestamp), pid: PID, tid: 0, args: { value } });
      }
    } else {
      trace.push({
        name: e.type,
        ph: "i",
        s: "t",
        cat: "event",
        ts: us(e.timestamp),
        pid: PID,
        tid: TID_EVENTS,
        args: { id: e.id, ...(e.parentEventId ? { parent: e.parentEventId } : {}), ...e.payload },
      });
    }
  }
  const stages = options.stages ? stageTimings(options.stages).timings : [];
  if (stages.length) {
    trace.push({ name: "thread_name", ph: "M", ts: 0, pid: PID, tid: TID_STAGES, args: { name: "test runner" } });
    for (const st of stages) {
      trace.push({
        name: st.test ? `${st.stage} ${st.test}` : st.stage,
        ph: "X",
        cat: "stage",
        ts: us(st.startMs),
        dur: us(st.durationMs),
        pid: PID,
        tid: TID_STAGES,
        args: { stage: st.stage, ...(st.test ? { test: st.test } : {}), ...(st.iteration !== undefined ? { iteration: st.iteration } : {}) },
      });
    }
  }
  return { traceEvents: trace, displayTimeUnit: "ms" };
}
