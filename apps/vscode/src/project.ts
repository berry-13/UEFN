import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { describeFailure, resolveCli, runCli, type CliCommand, type CliRunOptions, type CliRunResult } from "./cli.ts";
import { resolveVerseDir } from "./mapping.ts";
import { DaemonHttp, readLiveDaemon } from "./daemon.ts";
import type { DaemonInfo } from "./types.ts";

export const CONFIG_FILE = "uefn-devtools.config.yaml";

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("uefnDevtools");
}

/** Number of path segments between `base` and `dir` (0 for `base` itself). */
function depthFrom(base: string, dir: string): number {
  const relative = path.relative(base, dir);
  return relative === "" ? 0 : relative.split(/[\\/]/).length;
}

/**
 * The UEFN project the extension serves: the directory holding
 * `uefn-devtools.config.yaml` (or `uefnDevtools.projectRoot`, or the first
 * workspace folder), plus the helpers every feature needs.
 */
export class Project implements vscode.Disposable {
  private readonly daemonEmitter = new vscode.EventEmitter<DaemonInfo | undefined>();
  /** Fires when a daemon appears, changes or goes away. */
  readonly onDidChangeDaemon = this.daemonEmitter.event;
  private daemonInfo: DaemonInfo | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  readonly root: string;
  readonly output: vscode.OutputChannel;

  private constructor(root: string, output: vscode.OutputChannel) {
    this.root = root;
    this.output = output;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, ".devtools/daemon.json"));
    const recheck = () => void this.refreshDaemon();
    watcher.onDidCreate(recheck);
    watcher.onDidChange(recheck);
    watcher.onDidDelete(recheck);
    this.disposables.push(watcher, this.daemonEmitter);
  }

  static async find(output: vscode.OutputChannel): Promise<Project | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return undefined;
    const base = folders[0]!.uri.fsPath;
    const configured = settings().get<string>("projectRoot", "").trim();
    if (configured) return new Project(path.resolve(base, configured), output);
    const found = await vscode.workspace.findFiles(`**/${CONFIG_FILE}`, "**/node_modules/**", 20);
    const dirs = found.map((u) => path.dirname(u.fsPath)).sort((a, b) => depthFrom(base, a) - depthFrom(base, b) || a.localeCompare(b));
    return new Project(dirs[0] ?? base, output);
  }

  get daemon(): DaemonInfo | undefined {
    return this.daemonInfo;
  }

  /** A client for the live daemon, if any. */
  client(): DaemonHttp | undefined {
    return this.daemonInfo ? new DaemonHttp(this.daemonInfo) : undefined;
  }

  /** Re-reads daemon.json and fires onDidChangeDaemon when the live daemon changed. */
  async refreshDaemon(): Promise<DaemonInfo | undefined> {
    const next = await readLiveDaemon(this.root);
    const changed = next?.pid !== this.daemonInfo?.pid || next?.port !== this.daemonInfo?.port || next?.token !== this.daemonInfo?.token;
    this.daemonInfo = next;
    if (changed) this.daemonEmitter.fire(next);
    return next;
  }

  /** The Verse source directory from `paths.verse` in the project config, or undefined when unreadable. */
  async verseDir(): Promise<string | undefined> {
    try {
      const text = await readFile(path.join(this.root, CONFIG_FILE), "utf8");
      return resolveVerseDir(text, this.root);
    } catch {
      return undefined;
    }
  }

  cli(): CliCommand {
    return resolveCli({
      configured: settings().get<string>("cliPath", ""),
      root: this.root,
      pathEnv: process.env.PATH ?? "",
    });
  }

  /** `--adapter <name>` when `uefnDevtools.adapter` is set. */
  adapterArgs(): string[] {
    const adapter = settings().get<string>("adapter", "").trim();
    return adapter ? ["--adapter", adapter] : [];
  }

  /** Runs `uefn <args> [--adapter x]` in the project root, logging the command line. */
  async run(args: string[], options: Omit<CliRunOptions, "cwd"> = {}): Promise<{ cli: CliCommand; args: string[]; result: CliRunResult }> {
    const cli = this.cli();
    const full = [...args, ...this.adapterArgs()];
    this.output.appendLine(`$ ${[cli.command, ...cli.args, ...full].join(" ")}  (cli from ${cli.source}, cwd ${this.root})`);
    const result = await runCli(cli, full, { ...options, cwd: this.root });
    if (result.spawnError || (result.code !== 0 && result.code !== 1 && !result.cancelled)) {
      this.output.appendLine(describeFailure(cli, full, result));
      if (result.stderr.trim()) this.output.appendLine(result.stderr.trimEnd());
    }
    return { cli, args: full, result };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
