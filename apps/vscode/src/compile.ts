import * as vscode from "vscode";
import { describeFailure, parseJsonOutput } from "./cli.ts";
import { mapDiagnostics, type MappedDiagnostic } from "./mapping.ts";
import type { Project } from "./project.ts";
import type { CompileResult } from "./types.ts";

const SEVERITY: Record<MappedDiagnostic["severity"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** "UEFN: Compile Verse" and compile on save, reported through a DiagnosticCollection. */
export class VerseCompiler implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("uefn-verse");
  private readonly disposables: vscode.Disposable[] = [this.diagnostics];
  private running: Promise<CompileResult | undefined> | undefined;
  private readonly project: Project;

  constructor(project: Project) {
    this.project = project;
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!doc.uri.fsPath.endsWith(".verse")) return;
        if (!vscode.workspace.getConfiguration("uefnDevtools").get<boolean>("compileOnSave", false)) return;
        void this.compile(false);
      }),
    );
  }

  /** Compiles once at a time; `interactive` shows a progress notification and a result message. */
  compile(interactive: boolean): Promise<CompileResult | undefined> {
    this.running ??= this.doCompile(interactive).finally(() => (this.running = undefined));
    return this.running;
  }

  private async doCompile(interactive: boolean): Promise<CompileResult | undefined> {
    const task = async (): Promise<CompileResult | undefined> => {
      const client = (await this.project.refreshDaemon()) && this.project.client();
      if (client) {
        try {
          return await client.compile();
        } catch (error) {
          this.project.output.appendLine(`Daemon compile failed, falling back to the CLI: ${(error as Error).message}`);
        }
      }
      const { cli, args, result } = await this.project.run(["compile", "--json"]);
      const parsed = parseJsonOutput<CompileResult>(result.stdout);
      if (!parsed) {
        void vscode.window.showErrorMessage(`UEFN compile failed: ${describeFailure(cli, args, result)}`);
        return undefined;
      }
      return parsed;
    };
    const result = interactive
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "UEFN: Compiling Verse" }, task)
      : await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Compiling Verse" }, task);
    if (!result) return undefined;
    this.apply(result, await this.project.verseDir());
    return result;
  }

  private apply(result: CompileResult, verseDir: string | undefined): void {
    const { byFile, general } = mapDiagnostics(result, this.project.root, verseDir);
    this.diagnostics.clear();
    for (const [file, list] of byFile) {
      this.diagnostics.set(
        vscode.Uri.file(file),
        list.map((d) => {
          const diagnostic = new vscode.Diagnostic(new vscode.Range(d.line, d.column, d.line, Number.MAX_SAFE_INTEGER), d.message, SEVERITY[d.severity]);
          diagnostic.source = "UEFN Verse";
          if (d.code) diagnostic.code = d.code;
          return diagnostic;
        }),
      );
    }
    for (const d of general) this.project.output.appendLine(`[compile ${d.severity}] ${d.message}`);
    const errors = result.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = result.diagnostics.filter((d) => d.severity === "warning").length;
    const text = result.success
      ? `Verse compiled in ${Math.round(result.durationMs)} ms (${warnings} warning(s))`
      : `Verse compile failed: ${errors} error(s), ${warnings} warning(s)`;
    this.project.output.appendLine(text);
    if (result.success) void vscode.window.setStatusBarMessage(text, 5000);
    else void vscode.window.showErrorMessage(text, "Show Problems").then((choice) => {
      if (choice) void vscode.commands.executeCommand("workbench.actions.view.problems");
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
