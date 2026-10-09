import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { McpUefnAdapter } from "@uefn-devtools/uefn";
import type { DevToolsConfig } from "@uefn-devtools/protocol";
import { loadConfig, type LoadedConfig } from "./config.ts";
import { scanTests, scanVerse } from "./deps.ts";
import type { DevToolsEngine } from "./engine.ts";
import { captureGitInfo } from "./git.ts";
import { TEST_FILE, walk } from "./project.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** Concrete next step; present on every failing check. */
  fix?: string;
}

export interface DoctorReport {
  root: string;
  configFile?: string;
  adapter: DevToolsConfig["adapter"];
  checks: DoctorCheck[];
  summary: Record<CheckStatus, number>;
  /** False when any check failed. */
  ok: boolean;
}

/** Same contract as `loadTests` from @uefn-devtools/test, injected because core cannot depend on it. */
export type DoctorTestLoader = (files: string[]) => Promise<{
  tests: { id: string; file: string }[];
  errors: { file: string; message: string }[];
}>;

export interface DoctorOptions {
  /** Used to load the config when no engine or loaded config is passed. */
  cwd?: string;
  configPath?: string;
  /** Overrides `adapter` from the config. */
  adapter?: DevToolsConfig["adapter"];
  /** Validates test files (YAML schema, TypeScript imports) and returns the registered tests. */
  loadTests?: DoctorTestLoader;
  /**
   * Launch the configured MCP server to check it answers. Off by default:
   * `mcp.command` comes from the project's config, so connecting runs it.
   */
  connect?: boolean;
  /** How long the MCP connection attempt may take. Default 10s. */
  connectTimeoutMs?: number;
  /** Node version to check, for tests. Defaults to the running process. */
  nodeVersion?: string;
}

export const MIN_NODE = "22.18.0";

function versionAtLeast(actual: string, min: string): boolean {
  const a = actual.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

async function isDir(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory(), () => false);
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isFile(), () => false);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const REQUIRED_TOOLS = ["compile", "start_session"] as const;
const OPTIONAL_TOOLS = ["project_info", "stop_session", "session_state"] as const;

/**
 * Environment and project health checks. Pass an engine or loaded config,
 * or neither to load the config from `options.cwd`; an unreadable config is
 * reported as a failed check instead of throwing.
 */
export async function runDoctor(source?: DevToolsEngine | LoadedConfig, options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => checks.push(check);
  const finish = (loaded: LoadedConfig | undefined, adapter: DevToolsConfig["adapter"]): DoctorReport => {
    const summary: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of checks) summary[c.status]++;
    return {
      root: loaded?.root ?? resolve(options.cwd ?? process.cwd()),
      ...(loaded?.file ? { configFile: loaded.file } : {}),
      adapter,
      checks,
      summary,
      ok: summary.fail === 0,
    };
  };

  const node = options.nodeVersion ?? process.versions.node;
  add(
    versionAtLeast(node, MIN_NODE)
      ? { id: "node.version", title: "Node.js version", status: "pass", detail: `${node} (requires >=${MIN_NODE})` }
      : {
          id: "node.version",
          title: "Node.js version",
          status: "fail",
          detail: `${node} is older than the required >=${MIN_NODE}`,
          fix: `install Node.js ${MIN_NODE} or newer (for example with nvm install 22)`,
        },
  );

  let loaded: LoadedConfig | undefined;
  if (source) loaded = "loaded" in source ? source.loaded : source;
  else {
    try {
      loaded = await loadConfig(options.cwd ?? process.cwd(), options.configPath);
    } catch (error) {
      add({
        id: "config.valid",
        title: "Configuration valid",
        status: "fail",
        detail: (error as Error).message,
        fix: "correct the reported fields in uefn-devtools.config.yaml (schema: packages/protocol/src/config.ts)",
      });
      return finish(undefined, options.adapter ?? "simulated");
    }
  }

  const { config, root } = loaded;
  const adapter = options.adapter ?? config.adapter;
  add(
    loaded.file
      ? { id: "config.found", title: "Configuration file", status: "pass", detail: relative(root, loaded.file) || loaded.file }
      : {
          id: "config.found",
          title: "Configuration file",
          status: "warn",
          detail: "no uefn-devtools.config.yaml found; using defaults",
          fix: "run 'uefn init' in the project root",
        },
  );
  add({ id: "config.valid", title: "Configuration valid", status: "pass", detail: `adapter: ${adapter}` });

  // Paths and project contents.
  const verseDir = resolve(root, config.paths.verse);
  const testsDir = resolve(root, config.paths.tests);
  for (const [id, label, dir, key] of [
    ["paths.verse", "Verse directory", verseDir, "paths.verse"],
    ["paths.tests", "Tests directory", testsDir, "paths.tests"],
  ] as const) {
    add(
      (await isDir(dir))
        ? { id, title: label, status: "pass", detail: relative(root, dir) || "." }
        : {
            id,
            title: label,
            status: "fail",
            detail: `${dir} does not exist`,
            fix: `create the directory or point ${key} at the right folder in the config`,
          },
    );
  }

  const verseFiles = await walk(verseDir, (n) => n.endsWith(".verse"));
  add(
    verseFiles.length > 0
      ? { id: "verse.files", title: "Verse files", status: "pass", detail: `${verseFiles.length} file(s)` }
      : {
          id: "verse.files",
          title: "Verse files",
          status: "warn",
          detail: `no .verse files under ${relative(root, verseDir) || "."}`,
          fix: "add your gameplay Verse sources under paths.verse",
        },
  );

  const testFiles = await walk(testsDir, (n) => TEST_FILE.test(n));
  if (!options.loadTests) {
    add({ id: "tests.discover", title: "Tests load and validate", status: "skip", detail: "no test loader supplied" });
    add({ id: "tests.ids", title: "Test ids unique", status: "skip", detail: "no test loader supplied" });
  } else if (testFiles.length === 0) {
    add({
      id: "tests.discover",
      title: "Tests load and validate",
      status: "warn",
      detail: `no *.test.yaml or *.test.ts files under ${relative(root, testsDir) || "."}`,
      fix: "write a test, for example Tests/first.test.yaml (see examples/capture-point)",
    });
    add({ id: "tests.ids", title: "Test ids unique", status: "skip", detail: "no tests" });
  } else {
    let result: Awaited<ReturnType<DoctorTestLoader>> | undefined;
    let loadError: string | undefined;
    try {
      result = await options.loadTests(testFiles);
    } catch (error) {
      loadError = (error as Error).message;
    }
    if (!result) {
      add({
        id: "tests.discover",
        title: "Tests load and validate",
        status: "fail",
        detail: `could not load tests: ${loadError}`,
        fix: "fix the error above, then re-run 'uefn doctor'",
      });
      add({ id: "tests.ids", title: "Test ids unique", status: "skip", detail: "tests could not be loaded" });
    } else if (result.errors.length > 0) {
      add({
        id: "tests.discover",
        title: "Tests load and validate",
        status: "fail",
        detail: result.errors.map((e) => `${relative(root, e.file)}: ${e.message.split("\n").join(" ")}`).join("\n"),
        fix: "fix the listed test files; YAML tests must match the schema in packages/test/src/yaml.ts",
      });
    } else {
      add({
        id: "tests.discover",
        title: "Tests load and validate",
        status: "pass",
        detail: `${result.tests.length} test(s) in ${testFiles.length} file(s)`,
      });
    }
    const seen = new Map<string, string[]>();
    for (const t of result?.tests ?? []) seen.set(t.id, [...(seen.get(t.id) ?? []), relative(root, t.file)]);
    const dupes = [...seen].filter(([, files]) => files.length > 1);
    if (result) add(
      dupes.length === 0
        ? { id: "tests.ids", title: "Test ids unique", status: "pass", detail: `${seen.size} unique id(s)` }
        : {
            id: "tests.ids",
            title: "Test ids unique",
            status: "fail",
            detail: dupes.map(([id, files]) => `'${id}' in ${files.join(", ")}`).join("; "),
            fix: "rename one of the tests, or give it an explicit 'id:' (YAML) so ids do not collide",
          },
    );
  }

  const git = await captureGitInfo(root);
  add(
    git
      ? { id: "git.repo", title: "Git repository", status: "pass", detail: `${git.branch ?? "(detached)"} ${git.commit ?? ""}${git.dirty ? " (dirty)" : ""}`.trim() }
      : {
          id: "git.repo",
          title: "Git repository",
          status: "warn",
          detail: "not inside a git repository; sessions will not record a revision",
          fix: "run 'git init' in the project root",
        },
  );

  const resultsDir = resolve(root, config.paths.results);
  let probe = resultsDir;
  while (!(await isDir(probe)) && dirname(probe) !== probe) probe = dirname(probe);
  const writable = await access(probe, constants.W_OK).then(() => true, () => false);
  add(
    writable
      ? { id: "results.writable", title: "Results directory writable", status: "pass", detail: relative(root, resultsDir) || "." }
      : {
          id: "results.writable",
          title: "Results directory writable",
          status: "fail",
          detail: `${probe} is not writable`,
          fix: `make ${probe} writable or change paths.results in the config`,
        },
  );

  // Adapter specific.
  if (adapter === "simulated") await checkSimulated(add, loaded, testFiles);
  else {
    for (const id of ["simulated.devices", "simulated.refs"]) {
      add({ id, title: id === "simulated.devices" ? "Simulated devices" : "Tests reference known devices", status: "skip", detail: "adapter is mcp" });
    }
  }
  if (adapter === "mcp") await checkMcp(add, loaded, verseFiles, options);
  else {
    for (const [id, title] of [
      ["mcp.server", "MCP server configured"],
      ["mcp.connect", "MCP server reachable"],
      ["mcp.tools", "MCP tool mappings"],
      ["mcp.tool_names", "Mapped tools exist on server"],
      ["runtime.log", "Runtime log path"],
      ["verse.runtime", "DevTools Verse runtime"],
    ] as const) {
      add({ id, title, status: "skip", detail: "adapter is simulated" });
    }
  }

  await checkDaemon(add, root);
  return finish(loaded, adapter);
}

type Add = (check: DoctorCheck) => void;

async function checkSimulated(add: Add, loaded: LoadedConfig, testFiles: string[]): Promise<void> {
  const { config, root } = loaded;
  const devices = config.simulated.devices;
  add(
    devices.length > 0
      ? { id: "simulated.devices", title: "Simulated devices", status: "pass", detail: devices.map((d) => d.id).join(", ") }
      : {
          id: "simulated.devices",
          title: "Simulated devices",
          status: "warn",
          detail: "simulated.devices is empty",
          fix: "add devices under simulated.devices in the config (id, capture_time_ms, score)",
        },
  );
  const known = new Set(devices.map((d) => d.id));
  const tests = await scanTests(root, testFiles.map((f) => relative(root, f)));
  const missing = new Map<string, string[]>();
  for (const t of tests) {
    for (const ref of t.devices) {
      if (known.has(ref.id)) continue;
      const where = `${t.file}${ref.line ? `:${ref.line}` : ""} (${t.id}, ${ref.role ?? "device"})`;
      missing.set(ref.id, [...(missing.get(ref.id) ?? []), where]);
    }
  }
  add(
    missing.size === 0
      ? { id: "simulated.refs", title: "Tests reference known devices", status: "pass", detail: `${tests.length} test(s) checked` }
      : {
          id: "simulated.refs",
          title: "Tests reference known devices",
          status: "fail",
          detail: [...missing].map(([id, where]) => `'${id}' used by ${where[0]}${where.length > 1 ? ` and ${where.length - 1} more` : ""}`).join("\n"),
          fix: `add ${[...missing.keys()].map((id) => `'${id}'`).join(", ")} to simulated.devices, or correct the id in the test`,
        },
  );
}

async function checkMcp(add: Add, loaded: LoadedConfig, verseFiles: string[], options: DoctorOptions): Promise<void> {
  const { config, root } = loaded;
  const mcp = config.mcp;
  const configured = Boolean(mcp.command || mcp.url);
  add(
    configured
      ? { id: "mcp.server", title: "MCP server configured", status: "pass", detail: mcp.url ? `url ${mcp.url}` : `command ${[mcp.command, ...mcp.args].join(" ")}` }
      : {
          id: "mcp.server",
          title: "MCP server configured",
          status: "fail",
          detail: "neither mcp.command nor mcp.url is set",
          fix: "set mcp.command (stdio launcher) or mcp.url (streamable HTTP) in the config",
        },
  );

  const unmappedRequired = REQUIRED_TOOLS.filter((k) => !mcp.tools[k]);
  const unmappedOptional = OPTIONAL_TOOLS.filter((k) => !mcp.tools[k]);
  if (unmappedRequired.length > 0) {
    add({
      id: "mcp.tools",
      title: "MCP tool mappings",
      status: "fail",
      detail: `missing required: ${unmappedRequired.join(", ")}${unmappedOptional.length ? `; optional unmapped: ${unmappedOptional.join(", ")}` : ""}`,
      fix: `run 'uefn capabilities --adapter mcp' and set ${unmappedRequired.map((k) => `mcp.tools.${k}`).join(", ")}`,
    });
  } else if (unmappedOptional.length > 0) {
    add({
      id: "mcp.tools",
      title: "MCP tool mappings",
      status: "warn",
      detail: `required mapped; optional unmapped: ${unmappedOptional.join(", ")}`,
      fix: `map ${unmappedOptional.map((k) => `mcp.tools.${k}`).join(", ")} if the server has matching tools (uefn capabilities --adapter mcp)`,
    });
  } else {
    add({ id: "mcp.tools", title: "MCP tool mappings", status: "pass", detail: "all operations mapped" });
  }

  if (!configured) {
    add({ id: "mcp.connect", title: "MCP server reachable", status: "skip", detail: "server not configured" });
    add({ id: "mcp.tool_names", title: "Mapped tools exist on server", status: "skip", detail: "server not configured" });
  } else if (!options.connect) {
    add({ id: "mcp.connect", title: "MCP server reachable", status: "skip", detail: "not attempted (runs mcp.command; use --deep)" });
    add({ id: "mcp.tool_names", title: "Mapped tools exist on server", status: "skip", detail: "not attempted (use --deep)" });
  } else {
    const adapter = new McpUefnAdapter({ mcp });
    const timeoutMs = options.connectTimeoutMs ?? 10_000;
    let tools: string[] | undefined;
    try {
      await withTimeout(adapter.connect(), timeoutMs, "connecting to the MCP server");
      tools = ((await adapter.describeCapabilities()).tools ?? []).map((t) => t.name);
      add({ id: "mcp.connect", title: "MCP server reachable", status: "pass", detail: `${tools.length} tool(s) exposed` });
    } catch (error) {
      add({
        id: "mcp.connect",
        title: "MCP server reachable",
        status: "fail",
        detail: (error as Error).message,
        fix: mcp.url
          ? "start UEFN with its MCP server enabled and check that mcp.url is correct"
          : "run mcp.command by hand to see why it exits; check the path, arguments and that UEFN is running",
      });
    } finally {
      await adapter.disconnect().catch(() => {});
    }
    if (!tools) {
      add({ id: "mcp.tool_names", title: "Mapped tools exist on server", status: "skip", detail: "could not connect" });
    } else {
      const mapped = Object.entries(mcp.tools).filter((e): e is [string, string] => typeof e[1] === "string");
      const absent = mapped.filter(([, name]) => !tools.includes(name));
      add(
        absent.length === 0
          ? { id: "mcp.tool_names", title: "Mapped tools exist on server", status: "pass", detail: mapped.length ? mapped.map(([, n]) => n).join(", ") : "nothing mapped" }
          : {
              id: "mcp.tool_names",
              title: "Mapped tools exist on server",
              status: "fail",
              detail: `${absent.map(([k, n]) => `mcp.tools.${k}='${n}'`).join(", ")} not exposed; server has: ${tools.slice(0, 12).join(", ")}${tools.length > 12 ? ", ..." : ""}`,
              fix: "correct the tool names under mcp.tools using the list from 'uefn capabilities --adapter mcp'",
            },
      );
    }
  }

  const logPath = config.runtime.log_path;
  if (!logPath) {
    add({
      id: "runtime.log",
      title: "Runtime log path",
      status: "fail",
      detail: "runtime.log_path is not set; runtime events cannot be observed",
      fix: "set runtime.log_path to the UEFN output log (UnrealEditorFortnite.log under Saved/Logs)",
    });
  } else {
    const abs = resolve(root, logPath);
    if (await isFile(abs)) add({ id: "runtime.log", title: "Runtime log path", status: "pass", detail: abs });
    else if (await isDir(dirname(abs))) {
      add({
        id: "runtime.log",
        title: "Runtime log path",
        status: "warn",
        detail: `${abs} does not exist yet (UEFN creates it on launch)`,
        fix: "launch UEFN once, then re-run 'uefn doctor' to confirm the path",
      });
    } else {
      add({
        id: "runtime.log",
        title: "Runtime log path",
        status: "fail",
        detail: `directory ${dirname(abs)} does not exist`,
        fix: "correct runtime.log_path; it must point at the UEFN output log file",
      });
    }
  }

  let emitter = false;
  let scanError: string | undefined;
  try {
    for (const file of verseFiles) {
      const scan = scanVerse(file, await readFile(file, "utf8"));
      if (scan.decls.some((d) => d.name === "devtools_emitter") || scan.identifiers.some((i) => i.name === "devtools_emitter")) {
        emitter = true;
        break;
      }
    }
  } catch (error) {
    scanError = (error as Error).message;
  }
  add(
    scanError
      ? {
          id: "verse.runtime",
          title: "DevTools Verse runtime",
          status: "fail",
          detail: `could not scan Verse files: ${scanError}`,
          fix: `check that the files under ${config.paths.verse} are readable`,
        }
      : emitter
      ? { id: "verse.runtime", title: "DevTools Verse runtime", status: "pass", detail: "devtools_emitter found in project Verse" }
      : {
          id: "verse.runtime",
          title: "DevTools Verse runtime",
          status: "fail",
          detail: "no Verse file declares or uses devtools_emitter",
          fix: `copy runtime/verse/devtools.verse into ${config.paths.verse} and give your devices a devtools_emitter`,
        },
  );
}

async function checkDaemon(add: Add, root: string): Promise<void> {
  const title = "Daemon state";
  const file = resolve(root, ".devtools", "daemon.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    add({ id: "daemon.stale", title, status: "skip", detail: "no .devtools/daemon.json" });
    return;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    add({ id: "daemon.stale", title, status: "warn", detail: ".devtools/daemon.json is not valid JSON", fix: "delete .devtools/daemon.json" });
    return;
  }
  const rec = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const pid = typeof rec["pid"] === "number" ? rec["pid"] : undefined;
  const port = typeof rec["port"] === "number" ? rec["port"] : undefined;
  if (pid === undefined) {
    add({ id: "daemon.stale", title, status: "warn", detail: ".devtools/daemon.json has no pid", fix: "delete .devtools/daemon.json" });
  } else if (pidAlive(pid)) {
    add({ id: "daemon.stale", title, status: "pass", detail: `pid ${pid}${port !== undefined ? ` on port ${port}` : ""} is running` });
  } else {
    add({
      id: "daemon.stale",
      title,
      status: "warn",
      detail: `pid ${pid}${port !== undefined ? ` (port ${port})` : ""} is not running; the daemon file is stale`,
      fix: "delete .devtools/daemon.json (the next daemon start recreates it)",
    });
  }
}
