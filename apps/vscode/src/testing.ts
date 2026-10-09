import * as path from "node:path";
import * as vscode from "vscode";
import { describeFailure, parseJsonOutput } from "./cli.ts";
import { groupByFile, mapRunSummary, planRuns, type MappedResult } from "./mapping.ts";
import type { Project } from "./project.ts";
import type { ListResult, ListedTest, RunSummary } from "./types.ts";

const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

/** Test Explorer integration: discovery through `uefn list --json`, runs through the CLI or the daemon. */
export class UefnTests implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tests = new Map<vscode.TestItem, ListedTest>();
  private listed: ListedTest[] = [];
  private discovering: Promise<void> | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private readonly project: Project;

  constructor(project: Project) {
    this.project = project;
    this.controller = vscode.tests.createTestController("uefnDevtools", "UEFN DevTools");
    this.controller.resolveHandler = async (item) => {
      if (!item) await this.discover();
    };
    this.controller.refreshHandler = async () => {
      await this.discover();
    };
    this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, (request, token) => this.run(request, token, 1), true);
    this.controller.createRunProfile("Run with repeat...", vscode.TestRunProfileKind.Run, async (request, token) => {
      const value = await vscode.window.showInputBox({
        title: "Run with repeat",
        prompt: "How many times should each selected test run? The result shows its reliability.",
        value: "10",
        validateInput: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 1000 ? undefined : "Enter a whole number from 1 to 1000"),
      });
      if (value === undefined) return;
      await this.run(request, token, Number(value.trim()));
    }, false);
    this.disposables.push(this.controller);
    this.watchTestFiles();
  }

  private watchTestFiles(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.project.root, "**/*.test.{ts,yaml,yml}"));
    const schedule = (uri: vscode.Uri) => {
      if (uri.fsPath.includes(`${path.sep}node_modules${path.sep}`)) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.discover(), 500);
    };
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    this.disposables.push(watcher);
  }

  listedIds(): string[] {
    return this.listed.map((t) => t.id);
  }

  /** Re-lists tests and rebuilds the tree. Concurrent calls share one CLI run. */
  discover(): Promise<void> {
    this.discovering ??= this.doDiscover().finally(() => (this.discovering = undefined));
    return this.discovering;
  }

  private async doDiscover(): Promise<void> {
    const { cli, args, result } = await this.project.run(["list", "--json"]);
    const listing = parseJsonOutput<ListResult>(result.stdout);
    if (!listing) {
      const message = describeFailure(cli, args, result);
      this.project.output.appendLine(`Test discovery failed: ${message}`);
      const item = this.controller.createTestItem("uefn:discovery-error", "Test discovery failed");
      item.error = message;
      this.controller.items.replace([item]);
      this.tests.clear();
      this.listed = [];
      return;
    }
    this.listed = listing.tests;
    this.tests.clear();
    const fileItems: vscode.TestItem[] = [];
    for (const group of groupByFile(listing.tests)) {
      const uri = vscode.Uri.file(group.file);
      const fileItem = this.controller.createTestItem(`file:${group.file}`, path.basename(group.file), uri);
      fileItem.description = path.relative(listing.root, path.dirname(group.file)) || undefined;
      for (const t of group.tests) {
        const item = this.controller.createTestItem(`${group.file}::${t.id}`, t.name, uri);
        if (t.line !== undefined) item.range = new vscode.Range(t.line - 1, 0, t.line - 1, 0);
        item.description = t.skip ? `${t.id} (skipped)` : t.id;
        fileItem.children.add(item);
        this.tests.set(item, t);
      }
      fileItems.push(fileItem);
    }
    for (const e of listing.errors) {
      const id = `file:${e.file}`;
      let fileItem = fileItems.find((f) => f.id === id);
      if (!fileItem) {
        fileItem = this.controller.createTestItem(id, path.basename(e.file), vscode.Uri.file(e.file));
        fileItems.push(fileItem);
      }
      fileItem.error = e.message;
    }
    this.controller.items.replace(fileItems);
    this.project.output.appendLine(`Discovered ${listing.tests.length} test(s) in ${listing.testsDir}`);
  }

  private collect(request: vscode.TestRunRequest): vscode.TestItem[] {
    const excluded = new Set(request.exclude ?? []);
    const out: vscode.TestItem[] = [];
    const visit = (item: vscode.TestItem) => {
      if (excluded.has(item)) return;
      if (this.tests.has(item)) out.push(item);
      item.children.forEach(visit);
    };
    if (request.include) request.include.forEach(visit);
    else this.controller.items.forEach(visit);
    return out;
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, repeat: number): Promise<void> {
    if (this.tests.size === 0) await this.discover();
    const items = this.collect(request);
    const run = this.controller.createTestRun(request, repeat > 1 ? `UEFN tests (repeat ${repeat})` : "UEFN tests");
    const abort = new AbortController();
    const cancel = token.onCancellationRequested(() => abort.abort());
    try {
      for (const item of items) run.enqueued(item);
      const byId = new Map<string, vscode.TestItem[]>();
      for (const item of items) {
        const id = this.tests.get(item)!.id;
        byId.set(id, [...(byId.get(id) ?? []), item]);
      }
      for (const filter of planRuns([...byId.keys()], this.listed)) {
        if (token.isCancellationRequested) break;
        const ids = filter === undefined ? [...byId.keys()] : [filter];
        const targets = ids.flatMap((id) => byId.get(id) ?? []);
        for (const item of targets) run.started(item);
        const summary = await this.execute(run, filter, repeat, abort.signal);
        if (token.isCancellationRequested) {
          for (const item of targets) run.skipped(item);
          break;
        }
        if (typeof summary === "string") {
          for (const item of targets) run.errored(item, new vscode.TestMessage(summary));
          continue;
        }
        const mapped = mapRunSummary(summary, ids);
        for (const [id, result] of mapped) {
          for (const item of byId.get(id) ?? []) this.report(run, item, result);
        }
      }
    } finally {
      cancel.dispose();
      run.end();
    }
  }

  /** Runs one filter through the daemon when one is live, otherwise through the CLI. Returns an error string on failure. */
  private async execute(run: vscode.TestRun, filter: string | undefined, repeat: number, signal: AbortSignal): Promise<RunSummary | string> {
    const daemon = (await this.project.refreshDaemon()) && this.project.client();
    if (daemon) {
      run.appendOutput(crlf(`Running ${filter ?? "all tests"} through the daemon on port ${this.project.daemon!.port}\n`));
      try {
        return await daemon.runTests({ ...(filter ? { filter } : {}), ...(repeat > 1 ? { repeat } : {}) }, signal);
      } catch (error) {
        if (signal.aborted) return "Cancelled (the daemon finishes the run in the background)";
        return `Daemon run failed: ${(error as Error).message}`;
      }
    }
    const args = ["test", ...(filter ? [filter] : []), "--json", ...(repeat > 1 ? ["--repeat", String(repeat)] : [])];
    const { cli, args: full, result } = await this.project.run(args, {
      signal,
      onStderr: (text) => run.appendOutput(crlf(text)),
    });
    if (result.cancelled) return "Cancelled";
    const summary = parseJsonOutput<RunSummary>(result.stdout);
    return summary ?? describeFailure(cli, full, result);
  }

  private report(run: vscode.TestRun, item: vscode.TestItem, result: MappedResult): void {
    if (result.reliability) run.appendOutput(crlf(`${item.label}: ${result.reliability}\n`), undefined, item);
    const messages = result.messages.map((m) => {
      const message =
        m.expected !== undefined || m.actual !== undefined
          ? vscode.TestMessage.diff(m.message, m.expected ?? "", m.actual ?? "")
          : new vscode.TestMessage(m.message);
      if (item.uri && item.range) message.location = new vscode.Location(item.uri, item.range);
      return message;
    });
    switch (result.outcome) {
      case "passed":
        run.passed(item, result.durationMs);
        break;
      case "skipped":
        run.skipped(item);
        break;
      case "failed":
        run.failed(item, messages, result.durationMs);
        break;
      case "errored":
        run.errored(item, messages, result.durationMs);
        break;
    }
  }

  dispose(): void {
    clearTimeout(this.debounce);
    for (const d of this.disposables) d.dispose();
  }
}
