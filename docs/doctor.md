# Project Doctor

`uefn doctor` analyses project health (spec §26–28). It needs no running
session and no UEFN install: it reads the Verse sources, tests, recent run
results and recordings.

```
$ uefn doctor
UEFN PROJECT HEALTH

Verse                   95
Devices                100
Performance             94
Assets                 n/a  (needs UEFN asset data)
Tests                  100
Publish readiness      n/a  (needs UEFN validation)
DevTools setup         100

Critical     0
Warnings     2
Info         1

UEFN-V104  warning  Verse/round_manager.verse:23
  Duplicate subscription detected: SpawnedEvent → OnPlayerSpawned  (heuristic)
  Event: Spawner.SpawnedEvent
  Subscribed from: OnBegin() (line 16), Initialize() (line 19), OnRoundStarted() (line 23)
  Potential result: handler executes twice
```

Exit code `1` when a finding is at or above `doctor.severity.fail_on`
(default `error`), so it can gate CI. Also available as `--json`, the MCP
tool `uefn_get_project_health`, the daemon method `doctor.run`, and the
dashboard's Doctor view.

## How it reads Verse

DevTools does not have a Verse compiler. The doctor uses a **structural
scanner**: comments (`#`, nested `<# #>`) and string contents are removed,
interpolated expressions (`"{Score}"`) are kept, and functions, `loop:`,
`for`, `spawn` and other blocks are recovered from indentation. Rules built
on it are **heuristics** and are labelled so. Read the code before acting on
one, and use the compiler (`uefn compile`) as the authority on validity.

Scores are 100 minus 15 per error, 5 per warning and 1 per info, per
category. Assets and Publish readiness show `n/a` until DevTools can get
that data from UEFN.

## Rules

| Rule | Severity | Finds |
|---|---|---|
| UEFN-V101 | warning | indentation mixing tabs and spaces |
| UEFN-V102 | warning | `loop:` with no Sleep / Await / break / return (*heuristic*: a called function might suspend) |
| UEFN-V103 | info | `var` written but never read |
| UEFN-V104 | warning | same handler subscribed to the same event more than once, or inside a loop |
| UEFN-V105 | info | subscription outside `OnBegin` whose cancelable is discarded |
| UEFN-V106 | warning | `spawn` inside a loop (unbounded tasks) |
| UEFN-D201 | warning | `@editable` field never referenced |
| UEFN-P301 | info | `GetPlayers()` inside a loop |
| UEFN-P302 | warning | loop sleeping under 0.1 s (high-frequency polling) |
| UEFN-T401 | warning | no tests |
| UEFN-T402 | error | a test file fails to load or validate |
| UEFN-T403 | warning | the latest run did not pass |
| UEFN-T404 | warning | a repeated test is flaky in the latest run |
| UEFN-T405 | info | a bug recording with anomalies not yet turned into a test |
| UEFN-S501 | error / warning / info | the DevTools runtime is used but missing (error), or missing for the mcp adapter (warning) |
| UEFN-S502 | warning | the runtime is installed but `Hello()` is never called, so runs time out waiting for it |
| UEFN-S503 | error / warning | the mcp adapter lacks a server, the log path or tool mappings |

## Configuring

```yaml
doctor:
  severity:
    fail_on: warning        # error | warning | info | never
  rules:
    UEFN-V103: off          # or error | warning | info
```

Suppress one finding in code with a comment on, or directly above, its line:

```verse
    # devtools-ignore UEFN-V105
    Button.InteractedWithEvent.Subscribe(OnPressed)
```

## Custom rules

Rules implement the spec's interface and are pure functions of the project
context:

```ts
import { BUILTIN_RULES, buildContext, runRules, type Rule } from "@uefn-devtools/doctor";

const noTodo: Rule = {
  id: "TEAM-001", category: "verse", severity: "info", title: "TODO left in Verse",
  description: "…",
  evaluate: (ctx) => ctx.verse.flatMap((f) =>
    f.lines.filter((l) => l.raw.includes("TODO")).map((l) => ({
      ruleId: "TEAM-001", category: "verse", severity: "info", message: "TODO", file: f.path, line: l.number,
    }))),
};

const report = runRules(await buildContext(loaded), { rules: [...BUILTIN_RULES, noTodo] });
```
