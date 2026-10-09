# uefn doctor

`uefn doctor` checks that a project is ready to run DevTools and prints one
line per check with a fix for anything that needs attention.

```
uefn doctor [--deep] [--json] [--adapter simulated|mcp] [--config <path>]
```

By default doctor runs no project code, so it is safe on an unfamiliar
checkout: YAML tests are parsed and validated, TypeScript tests are not
imported, and the MCP server is not launched. `--deep` adds both, with the
same trust as `uefn test` (TypeScript tests are executed modules and
`mcp.command` is a program the config names).

Exit code is 1 when any check fails and 0 otherwise (warnings do not fail).
Symbols: `✓` pass, `✗` fail, `!` warning, `-` skipped.

## Checks

| id | What it verifies |
|---|---|
| `node.version` | Node.js is at least 22.18 |
| `config.found`, `config.valid` | A config file exists and parses; zod issues are shown on failure |
| `paths.verse`, `paths.tests` | The configured directories exist |
| `verse.files` | At least one `.verse` file is present |
| `tests.discover`, `tests.ids` | Tests load (YAML schema; TypeScript imports with `--deep`) and ids are unique |
| `git.repo` | The project is inside a git repository |
| `results.writable` | The results directory, or its nearest existing parent, is writable |
| `simulated.devices`, `simulated.refs` | Simulated adapter: devices are configured and every device id, `teleport.location` and `enter.area` used by a test exists |
| `mcp.server`, `mcp.tools` | MCP adapter: `mcp.command` or `mcp.url` is set; `compile` and `start_session` are mapped (the other mappings warn) |
| `mcp.connect`, `mcp.tool_names` | With `--deep`: the server connects within 10s and every mapped tool name exists in its tool list |
| `runtime.log` | `runtime.log_path` is set; missing file with an existing directory is a warning |
| `verse.runtime` | Some Verse file declares or uses `devtools_emitter` (see `runtime/verse`) |
| `daemon.stale` | `.devtools/daemon.json` does not point at a dead pid |

Checks that do not apply to the selected adapter are reported as skipped.

## Library use

```ts
import { runDoctor } from "@uefn-devtools/core";
import { loadTests } from "@uefn-devtools/test";

const report = await runDoctor(engine /* or LoadedConfig, or undefined */, { loadTests });
// report.checks: { id, title, status: "pass"|"warn"|"fail"|"skip", detail, fix? }[]
```

`loadTests` is injected because core cannot depend on the test package; without
it the test checks are skipped.
