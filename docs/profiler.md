# Profiler

`uefn profile` turns a session's event log into a profile: where time goes,
which events dominate, and how long effects take to follow their causes.

```
uefn profile [filter]                      # run the selected tests once, then profile
uefn profile --file events.jsonl           # profile a recorded artifact
uefn profile --out profile.json            # also write the profile as JSON
uefn profile --chrome-trace trace.json     # Chrome trace for chrome://tracing / ui.perfetto.dev
```

Agents get the same profile from the MCP tool `uefn_profile`
(`read_project` scope), computed over the current session's events.

## What is real and what is not

| Section | Source | Status |
|---|---|---|
| Session duration, throughput, hot event types | DERIVED from event timestamps | Works with any transport |
| Causal latency | DERIVED from `parentEventId` links | Works with any transport that emits parent links |
| Run stage timings | DERIVED from runner stage transitions | Works with any adapter |
| Spans (`perf.span`) | INSTRUMENTED: `ProfileBegin` / `ProfileEnd` / `ProfileSpan` in `runtime/verse/devtools.verse` | **Unverified** in UEFN, like the rest of that file |
| Samples (`perf.sample`) | INSTRUMENTED: `PerfSample` in `devtools.verse` | **Unverified**. Verse exposes no memory or engine frame-cost API that we know of, so `memory_mb` has no real source yet |

**The simulator's perf numbers are synthetic.** The simulated adapter emits
`perf.sample` and `perf.span` events from a cost model (world size plus seeded
jitter) so the pipeline can be exercised and tested. The values are
deterministic for a seed and never read the wall clock. They do not measure
anything. Disable them with:

```yaml
simulated:
  profiling:
    enabled: false
    sample_every_ticks: 10   # default: one sample per 10 simulator ticks
```

Timestamps are on the **session clock**. For the simulator that clock runs
`time_scale` times faster than real time, so "ms" in a simulated profile are
game milliseconds.

## Output

- **Session**: first to last event, event count, events per second.
- **Hot event types**: count, rate and share per type, highest first.
- **Spans**: per `name`: count, total, mean, p50, p95, max (`duration_ms`).
- **Samples**: per `<scope>.<metric>` (every numeric payload field of
  `perf.sample`): count, min, mean, p95, max.
- **Causal latency**: for each `parentType -> childType` edge, the time from
  parent to child: count, mean, p50, p95, max. `perf.*` children are left
  out because they measure their parent rather than follow from it.
- **Run stages** (only with `uefn profile [filter]`): total time per stage,
  and per test the time spent in `RUNNING`, `ASSERTING` and `CLEANUP`. A
  stage lasts until the next stage begins. Stage marks are taken on the
  session clock so they line up with runtime events in the trace.

Percentiles use the nearest-rank method: p95 of n values is the value at
rank `ceil(0.95 * n)` in ascending order. Small samples therefore report an
observed value, never an interpolated one.

## Chrome trace

`--chrome-trace` writes trace-event JSON (`displayTimeUnit: ms`, timestamps
in microseconds of session time), all in one process named "UEFN session":

| Track | Events |
|---|---|
| spans | `X` (complete) per `perf.span`; start is `timestamp - duration_ms` |
| test runner | `X` per runner stage, named `<STAGE> <test-id>` |
| runtime events | `i` (instant) per other runtime event, payload in `args` |
| counters | `C` per sample metric, one counter track per `<scope>.<metric>` |

## Instrumenting Verse

Not yet compiled against UEFN; expect small syntax fixes.

```verse
# A handler that suspends: the span covers the frames it waits for.
OnCaptured(Agent:agent)<suspends>:void =
    Start := DevTools.ProfileBegin()
    Seq := DevTools.Emit("capture.completed", array{DevToolsString("device", "A")})
    AwardScore(Agent)              # may Sleep / Await
    DevTools.ProfileEnd("capture_handler", Start, array{DevToolsParent(Seq)})

# Periodic samples from a long-running loop.
SampleLoop()<suspends>:void =
    var Last:float = DevTools.ProfileNow()
    loop:
        Sleep(0.0)                 # one frame
        Now := DevTools.ProfileNow()
        DevTools.PerfSample("world", array{
            DevToolsFloat("frame_ms", Now - Last),
            DevToolsInt("players", GetPlayspace().GetPlayers().Length)})
        set Last = Now
```

`GetSimulationElapsedTime` advances once per frame, so a span that starts and
ends in the same frame reads 0 ms. Spans measure latency across suspension
points, not CPU cost. `frame_ms` from a `Sleep(0.0)` loop is the simulation
frame interval, not engine frame cost. Both helpers write through `Print`, so
very high sample rates add log volume; one sample per second is plenty.
