#!/usr/bin/env node
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_FILE, DevToolsEngine, EventStore, captureGitInfo, formatCausalTree } from "@uefn-devtools/core";
import { RuntimeEvent } from "@uefn-devtools/protocol";
import { consoleReporter, runTests } from "@uefn-devtools/test";

const HELP = `uefn — UEFN DevTools

Usage: uefn <command> [options]

Commands
  status                 Project, adapter, session and git summary
  capabilities           What the adapter can do (DIRECT/INSTRUMENTED/...)
  compile                Compile Verse through the adapter
  test [filter]          Compile, start/reuse a session, run tests, assert
  trace <event-id>       Causal tree of an event from a recorded events.jsonl
  mcp                    Serve the DevTools MCP server over stdio
  init                   Write a starter ${CONFIG_FILE}

Global options
  --adapter <name>       simulated | mcp (overrides config)
  --config <path>        Config file (default: nearest ${CONFIG_FILE})
  --json                 Machine-readable output

test options
  --repeat <n>           Run each test n times and report reliability
  --seed <n>             Base seed (iteration i uses seed+i)
  --retries <n>          Retries per failing test (ignored with --repeat)
  --no-compile           Skip the Verse build stage
  --watch                Re-run when Verse or test files change
  --verbose              Print every iteration with --repeat

trace options
  --file <events.jsonl>  Recorded events (from .devtools/results/...)

mcp options
  --mode <mode>          read_only | development | full_access
`;

type Values = {
  adapter?: string;
  config?: string;
  json?: boolean;
  repeat?: string;
  seed?: string;
  retries?: string;
  "no-compile"?: boolean;
  watch?: boolean;
  verbose?: boolean;
  file?: string;
  mode?: string;
  help?: boolean;
};

function parse(argv: string[]): { command?: string; positionals: string[]; values: Values } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      adapter: { type: "string" },
      config: { type: "string" },
      json: { type: "boolean" },
      repeat: { type: "string" },
      seed: { type: "string" },
      retries: { type: "string" },
      "no-compile": { type: "boolean" },
      watch: { type: "boolean" },
      verbose: { type: "boolean" },
      file: { type: "string" },
      mode: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  return { ...(command ? { command } : {}), positionals: rest, values: values as Values };
}

function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} expects an integer`);
  return n;
}

class UsageError extends Error {}

async function openEngine(values: Values): Promise<DevToolsEngine> {
  const adapter = values.adapter;
  if (adapter !== undefined && adapter !== "simulated" && adapter !== "mcp") {
    throw new UsageError(`unknown adapter '${adapter}'`);
  }
  return DevToolsEngine.open({
    ...(values.config ? { configPath: values.config } : {}),
    ...(adapter ? { adapter } : {}),
  });
}

function print(values: Values, data: unknown, human: () => void): void {
  if (values.json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else human();
}

async function cmdStatus(values: Values): Promise<number> {
  const engine = await openEngine(values);
  const [project, git] = await Promise.all([engine.project(), captureGitInfo(engine.root)]);
  const data = {
    project: project.name,
    root: project.root,
    config: engine.loaded.file ?? null,
    adapter: engine.adapter.name,
    verseFiles: project.verseFiles.length,
    testFiles: project.testFiles.length,
    git: git ?? null,
  };
  print(values, data, () => {
    console.log(`Project   ${data.project}`);
    console.log(`Root      ${data.root}`);
    console.log(`Config    ${data.config ?? "(defaults — run 'uefn init')"}`);
    console.log(`Adapter   ${data.adapter}`);
    console.log(`Verse     ${data.verseFiles} file(s)`);
    console.log(`Tests     ${data.testFiles} file(s)`);
    if (git) console.log(`Git       ${git.branch ?? "(detached)"} ${git.commit ?? ""}${git.dirty ? " (dirty)" : ""}`);
  });
  return 0;
}

async function cmdCapabilities(values: Values): Promise<number> {
  const engine = await openEngine(values);
  try {
    const report = await engine.capabilities();
    print(values, report, () => {
      console.log(`Adapter: ${report.adapter}\n`);
      for (const c of report.capabilities) {
        console.log(`${c.status.padEnd(13)} ${c.feature}${c.via ? `  [${c.via}]` : ""}${c.notes ? `\n${" ".repeat(14)}${c.notes}` : ""}`);
      }
      if (report.tools) {
        console.log(`\nTools exposed by the UEFN MCP server (${report.tools.length}):`);
        for (const t of report.tools) console.log(`  ${t.name}${t.description ? ` — ${t.description.split("\n")[0]}` : ""}`);
      }
    });
    return 0;
  } finally {
    await engine.close();
  }
}

async function cmdCompile(values: Values): Promise<number> {
  const engine = await openEngine(values);
  try {
    const result = await engine.compile();
    print(values, result, () => {
      for (const d of result.diagnostics) {
        const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}: ` : "";
        console.log(`${d.severity.padEnd(7)} ${where}${d.message}`);
      }
      console.log(result.success ? `Verse ✓ (${result.durationMs.toFixed(0)}ms)` : "Verse ✗");
    });
    return result.success ? 0 : 1;
  } finally {
    await engine.close();
  }
}

async function cmdTest(values: Values, positionals: string[]): Promise<number> {
  if (values.watch) return watchTests();
  const engine = await openEngine(values);
  try {
    const repeat = int(values.repeat, "repeat");
    const seed = int(values.seed, "seed");
    const retries = int(values.retries, "retries");
    const summary = await runTests(engine, {
      ...(positionals[0] ? { filter: positionals[0] } : {}),
      ...(repeat !== undefined ? { repeat } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(retries !== undefined ? { retries } : {}),
      skipBuild: values["no-compile"] === true,
      ...(values.json ? {} : { onEvent: consoleReporter({ verbose: values.verbose === true }) }),
    });
    if (values.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return summary.status === "passed" ? 0 : summary.status === "failed" ? 1 : 2;
  } finally {
    await engine.close();
  }
}

/** Each run is a fresh process so edited test modules are re-imported. */
async function watchTests(): Promise<number> {
  const engine = await openEngine(parse(process.argv.slice(2)).values);
  const dirs = [engine.config.paths.verse, engine.config.paths.tests].map((d) => resolve(engine.root, d));
  const args = process.argv.slice(2).filter((a) => a !== "--watch");
  let running = false;
  let queued = false;
  const run = () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    console.clear();
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...args], { stdio: "inherit" });
    child.on("exit", () => {
      running = false;
      console.log("\nWatching for changes… (Ctrl+C to exit)");
      if (queued) {
        queued = false;
        run();
      }
    });
  };
  let debounce: NodeJS.Timeout | undefined;
  for (const dir of dirs) {
    try {
      watch(dir, { recursive: true }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(run, 200);
      });
    } catch {
      // Missing directory: nothing to watch there.
    }
  }
  run();
  return new Promise<number>(() => {});
}

async function cmdTrace(values: Values, positionals: string[]): Promise<number> {
  const id = positionals[0];
  if (!id || !values.file) throw new UsageError("usage: uefn trace <event-id> --file <events.jsonl>");
  const store = new EventStore();
  const lines = (await readFile(values.file, "utf8")).split("\n").filter((l) => l.trim());
  for (const line of lines) store.append(RuntimeEvent.parse(JSON.parse(line)));
  const tree = store.causalTree(id);
  if (!tree) {
    console.error(`event '${id}' not found in ${values.file}`);
    return 2;
  }
  print(values, tree, () => console.log(formatCausalTree(tree)));
  return 0;
}

async function cmdMcp(values: Values): Promise<number> {
  const mode = values.mode;
  if (mode !== undefined && mode !== "read_only" && mode !== "development" && mode !== "full_access") {
    throw new UsageError(`unknown mode '${mode}'`);
  }
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createDevToolsMcpServer } = await import("@uefn-devtools/mcp");
  const engine = await openEngine(values);
  const server = createDevToolsMcpServer({ engine, ...(mode ? { mode } : {}) });
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await engine.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise<number>(() => {});
}

const STARTER_CONFIG = `# UEFN DevTools configuration
project:
  name: MyIsland

paths:
  verse: ./Verse
  tests: ./Tests

# simulated: built-in reference simulator (no UEFN needed)
# mcp:       drive UEFN through its MCP server (see docs/capabilities.md)
adapter: simulated

simulated:
  devices:
    - id: CapturePointA
      capture_time_ms: 5000
      score: 50

mcp:
  # command: <launcher for the UEFN MCP server>
  # url: http://127.0.0.1:<port>/mcp
  tools: {}

runtime:
  # log_path: C:/Users/<you>/AppData/Local/UnrealEditorFortnite/Saved/Logs/UnrealEditorFortnite.log
  ready_timeout: 120s

tests:
  timeout: 30s
  retries: 0

mcp_server:
  mode: development
`;

async function cmdInit(): Promise<number> {
  const path = join(process.cwd(), CONFIG_FILE);
  if (await stat(path).then(() => true, () => false)) {
    console.error(`${CONFIG_FILE} already exists`);
    return 2;
  }
  await writeFile(path, STARTER_CONFIG);
  console.log(`Wrote ${CONFIG_FILE}`);
  return 0;
}

async function main(): Promise<number> {
  const { command, positionals, values } = parse(process.argv.slice(2));
  if (!command || values.help) {
    process.stdout.write(HELP);
    return command ? 0 : values.help ? 0 : 2;
  }
  switch (command) {
    case "status":
      return cmdStatus(values);
    case "capabilities":
      return cmdCapabilities(values);
    case "compile":
      return cmdCompile(values);
    case "test":
      return cmdTest(values, positionals);
    case "trace":
      return cmdTrace(values, positionals);
    case "mcp":
      return cmdMcp(values);
    case "init":
      return cmdInit();
    default:
      throw new UsageError(`unknown command '${command}'\n\n${HELP}`);
  }
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(error instanceof UsageError ? error.message : `error: ${error.message}`);
    process.exit(2);
  },
);
