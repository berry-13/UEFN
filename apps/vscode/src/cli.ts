import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

/** How to invoke the `uefn` CLI: `command ...args <subcommand ...>`. */
export interface CliCommand {
  command: string;
  args: string[];
  /** Where the command came from, for the output channel. */
  source: "setting" | "workspace" | "path" | "fallback";
  /** Needed for `.cmd` shims on Windows. */
  shell?: boolean;
}

export interface ResolveCliOptions {
  /** `uefnDevtools.cliPath`; empty means auto-detect. */
  configured?: string;
  /** Project root (directory holding the config file). Relative settings resolve against it. */
  root: string;
  /** Value of PATH. */
  pathEnv?: string;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
}

const isPathLike = (value: string) => value.includes("/") || value.includes("\\");

function fromFile(file: string, source: CliCommand["source"], platform: NodeJS.Platform): CliCommand {
  if (/\.[cm]?js$/i.test(file)) return { command: "node", args: [file], source };
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) return { command: file, args: [], source, shell: true };
  return { command: file, args: [], source };
}

/**
 * Resolves the CLI: the setting, then `node_modules/.bin/uefn` (or the
 * package's `dist/main.js`) in the project root and each ancestor, then
 * `uefn` on PATH. Falls back to the bare name so the spawn error is readable.
 */
export function resolveCli(options: ResolveCliOptions): CliCommand {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const p = platform === "win32" ? path.win32 : path.posix;
  const configured = options.configured?.trim();
  if (configured) {
    if (!isPathLike(configured)) return { command: configured, args: [], source: "setting", ...(platform === "win32" ? { shell: true } : {}) };
    return fromFile(p.resolve(options.root, configured), "setting", platform);
  }

  const binNames = platform === "win32" ? ["uefn.cmd", "uefn.exe", "uefn"] : ["uefn"];
  let dir = p.resolve(options.root);
  for (;;) {
    for (const name of binNames) {
      const bin = p.join(dir, "node_modules", ".bin", name);
      if (exists(bin)) return fromFile(bin, "workspace", platform);
    }
    // pnpm skips the bin link when the CLI was not built at install time; the entry point still works.
    const main = p.join(dir, "node_modules", "@uefn-devtools", "cli", "dist", "main.js");
    if (exists(main)) return fromFile(main, "workspace", platform);
    const parent = p.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const delimiter = platform === "win32" ? ";" : ":";
  for (const entry of (options.pathEnv ?? "").split(delimiter)) {
    if (!entry) continue;
    for (const name of binNames) {
      const bin = p.join(entry, name);
      if (exists(bin)) return fromFile(bin, "path", platform);
    }
  }
  return { command: "uefn", args: [], source: "fallback", ...(platform === "win32" ? { shell: true } : {}) };
}

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the run was stopped through `signal`. */
  cancelled: boolean;
  /** Set when the process could not be started (ENOENT and friends). */
  spawnError?: Error;
}

export interface CliRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Streams stderr while the process runs (progress from the console reporter). */
  onStderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** Spawns the CLI and collects its output. Aborting `signal` kills the process tree's leader. */
export function runCli(cli: CliCommand, args: string[], options: CliRunOptions): Promise<CliRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let settled = false;
    const finish = (result: Omit<CliRunResult, "stdout" | "stderr" | "cancelled">) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, stdout, stderr, cancelled });
    };
    const child = spawn(cli.command, [...cli.args, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: cli.shell ?? false,
      windowsHide: true,
    });
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 3000).unref();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => {
      stderr += d;
      options.onStderr?.(d);
    });
    child.on("error", (error) => finish({ code: null, spawnError: error }));
    child.on("close", (code) => finish({ code }));
  });
}

/** Parses the JSON document the CLI printed with `--json`; undefined when stdout is not JSON. */
export function parseJsonOutput<T>(stdout: string): T | undefined {
  const start = stdout.indexOf("{");
  if (start === -1) return undefined;
  try {
    return JSON.parse(stdout.slice(start)) as T;
  } catch {
    return undefined;
  }
}

/** One-line description of a failed CLI call, for notifications. */
export function describeFailure(cli: CliCommand, args: string[], result: CliRunResult): string {
  const line = [cli.command, ...cli.args, ...args].join(" ");
  if (result.spawnError) {
    const code = (result.spawnError as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? `Could not find the uefn CLI (${cli.command}). Install @uefn-devtools/cli in the workspace or set uefnDevtools.cliPath.`
      : `Could not start '${line}': ${result.spawnError.message}`;
  }
  const lastLine = result.stderr.trim().split(/\r?\n/).pop();
  return `'${line}' exited with code ${result.code}${lastLine ? `: ${lastLine}` : ""}`;
}
