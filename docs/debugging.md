# Headed and debug test runs

## `uefn test --headed`

Shows the running game while tests execute.

**Simulated adapter.** There is no game window, so the CLI renders the
derived GameState: phase, team scores, devices (state, owner, capture
progress bar), players (team, alive, health, areas) and the last few
non-`perf` events.

- On a TTY the view is drawn on the terminal's alternate screen and
  redrawn at most every 100 ms. Reporter output goes into the frame's log
  area. When the run ends the terminal is restored and the full report is
  printed normally, so it stays in scrollback.
- Without a TTY (CI, pipes) it prints a one-line state summary whenever the
  state changes (checked every 100 ms), interleaved with reporter lines:

```
Starting UEFN session...
Connected.
Waiting for runtime...
[headed t=2.01s] idle
[headed t=4.00s] playing | CapturePointA=Capturing(owner -, 0%) CapturePointB=Neutral(owner -, 0%) | player1(t1 hp100 @CapturePointA)
[headed t=8.00s] playing | teams 1:50 | CapturePointA=Captured(owner 1, 100%) CapturePointB=Neutral(owner -, 0%) | player1(t1 hp100 @CapturePointA)

Running:
capturing A awards 50 points
...
```

**mcp adapter.** `--headed` is forwarded as `{ "headed": true }` in the
arguments of the tool mapped to `mcp.tools.start_session`. Whether that tool
accepts the argument, and what it does with it, is **unverified**
(docs/capabilities.md). When the session is reused, no start call is made and
the hint has no effect. The terminal view described above works with this
adapter too, from the events the log transport receives.

The frame renderer is a pure function (`renderFrame`, `renderStateLine` in
`@uefn-devtools/test`).

## `uefn test --debug`

Step debugging in the terminal, in the spirit of the Playwright inspector.
It needs an interactive terminal (stdin and stdout must be TTYs) and cannot
be combined with `--json`. It forces `--repeat 1` and zero retries.

Before every step (fixture actions such as `game.start()`,
`player.enter()`, `game.wait()`, and every YAML `setup` / `steps` entry) the
run pauses and shows the step, the current state and recent events:

| Input | Effect |
|---|---|
| Enter | run this step and pause before the next |
| `c` | continue without pausing (failures still pause) |
| `s` | print the full derived state as JSON |
| `e [type]` | recent events of this attempt, optionally of one type (`ScoreChanged` or `score.changed`) |
| `t <event-id>` | causal tree around an event |
| `q` | abort the test; it is reported as failed with "aborted from the debugger" |

When an attempt fails (an assertion, a timeout, an error), the run pauses
once more before cleanup with the error, `expected` / `received` for
assertions, and the same inspection commands. Enter, `c` or `q` leave the
pause. If stdin closes, the debugger continues to the end.

Assertions (`expect`, YAML `assert:`) are not steps and do not pause.

### Time while paused

Tests are timed on the session clock (`Clock` in packages/uefn/src/clock.ts),
and the game does not know about the debugger. Two mechanisms keep a pause
from failing the test:

1. **The test budget excludes paused time.** Each phase's timeout timer is
   disarmed when a pause starts and re-armed on resume with the remaining
   budget, computed as `timeout - (elapsed - pausedMs)`. The attempt's
   `durationMs` also excludes paused time. This works for every clock.
2. **The simulated clock is frozen.** `ScaledClock` implements the optional
   `Clock.pause()` / `resume()`: `now()` stands still and `sleep()` does not
   complete while paused. The simulator's tick loop sleeps on that clock, so
   the world stops too: captures do not progress behind your back, event
   timestamps have no gap, and a debugged run behaves like an undebugged
   one.

A real Fortnite session cannot be paused from outside, so `RealClock` does
not implement `pause()`. The game keeps running while you read the screen:
a capture can complete during a pause. Only the test budget is protected.

Limits: pauses happen between steps, when nothing is waiting. A TS test that
starts an expectation without awaiting it and then hits a step pause keeps
that expectation's own timer running on the wall clock.

### Programmatic hooks

The CLI is one implementation of `RunOptions.debug`:

```ts
await runTests(engine, {
  debug: {
    beforeStep(info) {           // { test, index, description, engine, startIndex }
      return info.index === 2 ? "abort" : "step";   // "step" | "continue" | "abort"
    },
    onFailure(info) {            // { test, stage, error, expected?, received?, engine, startIndex }
      console.log(info.error);
    },
  },
});
```

Each hook may return a promise; the test stays paused until it settles.
