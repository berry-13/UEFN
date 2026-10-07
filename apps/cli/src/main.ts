#!/usr/bin/env node
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_FILE, DevToolsEngine, loadConfig, EventStore, captureGitInfo, formatCausalTree } from "@uefn-devtools/core";
import { RuntimeEvent, parseDuration, type RecordingSummary } from "@uefn-devtools/protocol";
import { consoleReporter, generateTest, runTests, toTypeScript, toYaml, writeGeneratedTest } from "@uefn-devtools/test";
import { formatRecordingSummary, listRecordings, loadRecording, summarizeRecording } from "@uefn-devtools/core";

const HELP = `uefn — UEFN DevTools

Usage: uefn <command> [options]

Commands
  status                 Project, adapter, session and git summary
  capabilities           What the adapter can do (DIRECT/INSTRUMENTED/...)
  compile                Compile Verse through the adapter
  test [filter]          Compile, start/reuse a session, run tests, assert
  trace <event-id>       Causal tree of an event from a recorded events.jsonl
  doctor                 Project health: static Verse analysis + project checks
  record                 Record a session; generate a test (or a bug report)
  recordings             List saved recordings
  generate-test <rec>    Generate a test from a recording id or file
  mcp                    Serve the DevTools MCP server over stdio
  daemon                 Shared engine: dashboard, JSON-RPC, MCP over HTTP
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
  --daemon               Run through the running daemon (visible on its dashboard)

trace options
  --file <events.jsonl>  Recorded events (from .devtools/results/...)

doctor options
  --fail-on <severity>   error | warning | info | never (default: doctor.severity.fail_on)

record / generate-test options
  --name <name>          Recording / test name
  --bug                  Bug recording: print an anomaly report, don't write a test
  --duration <d>         Stop after this long (e.g. 30s); default: Ctrl+C
  --format <yaml|ts>     Generated test format (default yaml)
  --counts               Also assert exact milestone event counts
  --print                generate-test: print instead of writing to the tests dir

mcp options
  --mode <mode>          read_only | development | full_access

daemon options
  --port <n>             Port on 127.0.0.1 (default 4917; 0 = any free port)
                         Token: random per start, or UEFN_DEVTOOLS_TOKEN
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
  port?: string;
  daemon?: boolean;
  name?: string;
  bug?: boolean;
  duration?: string;
  format?: string;
  counts?: boolean;
  print?: boolean;
  "fail-on"?: string;
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
      port: { type: "string" },
      daemon: { type: "boolean" },
      name: { type: "string" },
      bug: { type: "boolean" },
      duration: { type: "string" },
      format: { type: "string" },
      counts: { type: "boolean" },
      print: { type: "boolean" },
      "fail-on": { type: "string" },
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
  if (values.daemon) return testViaDaemon(values, positionals);
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

async function testViaDaemon(values: Values, positionals: string[]): Promise<number> {
  const { DaemonClient } = await import("@uefn-devtools/daemon");
  const { root } = await loadConfig(process.cwd(), values.config);
  const client = await DaemonClient.discover(root);
  if (!client) throw new UsageError("no daemon is running for this project (start one with 'uefn daemon')");
  const repeat = int(values.repeat, "repeat");
  const seed = int(values.seed, "seed");
  const reporter = values.json ? undefined : consoleReporter({ verbose: values.verbose === true });
  const abort = new AbortController();
  const stream = client.stream(abort.signal);
  // Subscribe before starting the run so no progress is missed.
  const first = await stream.next();
  if (first.done) throw new Error("daemon closed the event stream");
  const { runId } = (await client.call("tests.run", {
    ...(positionals[0] ? { filter: positionals[0] } : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(seed !== undefined ? { seed } : {}),
    compile: values["no-compile"] !== true,
  })) as { runId: string };
  for await (const message of stream) {
    if (message.channel !== "activity" || message.runId !== runId) continue;
    const event = message.data as Parameters<ReturnType<typeof consoleReporter>>[0];
    reporter?.(event);
    if (event.kind === "done") {
      abort.abort();
      if (values.json) process.stdout.write(JSON.stringify(event.summary, null, 2) + "\n");
      return event.summary.status === "passed" ? 0 : event.summary.status === "failed" ? 1 : 2;
    }
  }
  throw new Error("daemon stream ended before the run finished");
}

async function cmdDaemon(values: Values): Promise<number> {
  const { startDaemon, DEFAULT_PORT } = await import("@uefn-devtools/daemon");
  const engine = await openEngine(values);
  const port = int(values.port, "port") ?? DEFAULT_PORT;
  // A fixed token lets agent configs (MCP over HTTP) survive daemon restarts.
  const fixedToken = process.env["UEFN_DEVTOOLS_TOKEN"];
  if (fixedToken !== undefined && fixedToken.length < 24) throw new UsageError("UEFN_DEVTOOLS_TOKEN must be at least 24 characters");
  const daemon = await startDaemon({ engine, port, ...(fixedToken ? { token: fixedToken } : {}) });
  const { url, token } = daemon.info;
  console.log(`UEFN DevTools daemon for ${(await engine.project()).name} (${engine.adapter.name} adapter)`);
  console.log("");
  console.log(`  Dashboard  ${url}/#token=${token}`);
  console.log(`  MCP        ${url}/mcp   (header  Authorization: Bearer <token>)`);
  console.log(`  JSON-RPC   ${url}/rpc`);
  console.log("");
  console.log("Token and port are in .devtools/daemon.json (readable only by you). Ctrl+C to stop.");
  const shutdown = async () => {
    await daemon.close().catch(() => {});
    await engine.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise<number>(() => {});
}

function formatOf(values: Values): "yaml" | "ts" {
  const f = values.format ?? "yaml";
  if (f !== "yaml" && f !== "ts") throw new UsageError("--format must be yaml or ts");
  return f;
}

/** Resolves on Ctrl+C or after --duration, whichever comes first. */
function untilStopped(values: Values): Promise<void> {
  return new Promise((resolveStop) => {
    const done = () => {
      process.off("SIGINT", done);
      clearTimeout(timer);
      resolveStop();
    };
    process.on("SIGINT", done);
    const timer = values.duration ? setTimeout(done, parseDuration(values.duration)) : undefined;
  });
}

async function cmdRecord(values: Values): Promise<number> {
  const format = formatOf(values);
  const kind = values.bug ? "bug" : "scenario";
  const { root } = await loadConfig(process.cwd(), values.config);
  const { DaemonClient } = await import("@uefn-devtools/daemon");
  const client = values.adapter ? undefined : await DaemonClient.discover(root);
  const banner = (where: string) =>
    console.log(`● Recording${kind === "bug" ? " bug" : ""} via ${where}. Play now; ${values.duration ? `stopping after ${values.duration}` : "press Ctrl+C to stop"}.`);

  let summary: RecordingSummary;
  let written: string | undefined;
  let notes: string[] = [];
  if (client) {
    const state = await client.call("state.get", {});
    if (!state.session || state.session.status === "stopped") await client.call("session.start", {});
    const started = await client.call("recording.start", { kind, ...(values.name ? { name: values.name } : {}) });
    banner(`the daemon (${client.info.url}); its dashboard shows it live`);
    await untilStopped(values);
    const stopped = await client.call("recording.stop", {});
    summary = stopped.summary;
    if (kind === "scenario") {
      try {
        const generated = await client.call("recordings.generate", { id: started.id, format, counts: values.counts === true, write: true });
        written = generated.written;
        notes = generated.notes;
      } catch (error) {
        notes = [(error as Error).message];
      }
    }
  } else {
    const engine = await openEngine(values);
    try {
      await engine.startSession();
      await engine.waitForRuntime();
      engine.startRecording({ kind, ...(values.name ? { name: values.name } : {}) });
      banner(`a private ${engine.adapter.name} session`);
      if (engine.adapter.name === "simulated") {
        console.log("  (Nobody plays a private simulated session. Run 'uefn daemon' and use the dashboard's simulator controls.)");
      }
      await untilStopped(values);
      const { recording } = await engine.stopRecording();
      summary = summarizeRecording(recording);
      if (kind === "scenario") {
        const generated = generateTest(recording, { counts: values.counts === true });
        notes = generated.notes;
        const { relative, resolve: res } = await import("node:path");
        try {
          written = relative(engine.root, await writeGeneratedTest(res(engine.root, engine.config.paths.tests), generated, format, { recordingId: recording.id }));
        } catch (error) {
          notes.push((error as Error).message);
        }
      }
    } finally {
      await engine.close();
    }
  }
  console.log("");
  console.log(formatRecordingSummary(summary));
  console.log("");
  console.log(`Saved .devtools/recordings/${summary.id}.json`);
  if (written) console.log(`Generated test ${written}`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (kind === "bug") console.log(`Turn it into a regression test with: uefn generate-test ${summary.id}`);
  return 0;
}

async function cmdRecordings(values: Values): Promise<number> {
  const { root } = await loadConfig(process.cwd(), values.config);
  const list = await listRecordings(root);
  print(values, list, () => {
    if (list.length === 0) console.log("No recordings yet. Start one with 'uefn record'.");
    for (const r of list) {
      console.log(
        `${r.id}  ${new Date(r.startedAt).toLocaleString()}  ${r.kind.padEnd(8)} ${(r.durationMs / 1000).toFixed(1).padStart(6)}s ` +
          `${String(r.events).padStart(5)} events  ${r.anomalies.length ? `${r.anomalies.length} anomal${r.anomalies.length === 1 ? "y" : "ies"}  ` : ""}${r.name}`,
      );
    }
  });
  return 0;
}

async function cmdGenerateTest(values: Values, positionals: string[]): Promise<number> {
  const ref = positionals[0];
  if (!ref) throw new UsageError("usage: uefn generate-test <recording-id | recording.json> [--format yaml|ts] [--print]");
  const format = formatOf(values);
  const loaded = await loadConfig(process.cwd(), values.config);
  const recording = await loadRecording(loaded.root, ref);
  const generated = generateTest(recording, { counts: values.counts === true, ...(values.name ? { name: values.name } : {}) });
  const source = { recordingId: recording.id };
  if (values.print) {
    process.stdout.write(format === "ts" ? toTypeScript(generated, source) : toYaml(generated, source));
    return 0;
  }
  const { relative, resolve: res } = await import("node:path");
  const path = await writeGeneratedTest(res(loaded.root, loaded.config.paths.tests), generated, format, source);
  console.log(`Generated test ${relative(loaded.root, path)}`);
  for (const n of generated.notes) console.log(`  note: ${n}`);
  return 0;
}

async function cmdDoctor(values: Values): Promise<number> {
  const { runRules, buildContext, formatReport } = await import("@uefn-devtools/doctor");
  const loaded = await loadConfig(process.cwd(), values.config);
  const failOn = values["fail-on"];
  if (failOn !== undefined) {
    if (!["error", "warning", "info", "never"].includes(failOn)) throw new UsageError("--fail-on must be error, warning, info or never");
    loaded.config.doctor.severity.fail_on = failOn as typeof loaded.config.doctor.severity.fail_on;
  }
  const report = runRules(await buildContext(loaded));
  print(values, report, () => console.log(formatReport(report, { color: process.stdout.isTTY === true && !process.env["NO_COLOR"] })));
  return report.failed ? 1 : 0;
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

doctor:
  severity:
    fail_on: error
  # rules:
  #   UEFN-V103: off

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
    case "daemon":
      return cmdDaemon(values);
    case "doctor":
      return cmdDoctor(values);
    case "record":
      return cmdRecord(values);
    case "recordings":
      return cmdRecordings(values);
    case "generate-test":
      return cmdGenerateTest(values, positionals);
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
