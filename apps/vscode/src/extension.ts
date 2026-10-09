import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { describeFailure } from "./cli.ts";
import { VerseCompiler } from "./compile.ts";
import { Project } from "./project.ts";
import { UefnTests } from "./testing.ts";
import type { SessionSnapshot } from "./types.ts";
import { EventsProvider, LiveConnection, StateProvider } from "./views.ts";

/** Returned from activate; used by the extension-host smoke test and available to other extensions. */
export interface UefnDevtoolsApi {
  root: string;
  /** Re-runs discovery and resolves with the listed test ids. */
  discover(): Promise<string[]>;
}

export async function activate(context: vscode.ExtensionContext): Promise<UefnDevtoolsApi | undefined> {
  const output = vscode.window.createOutputChannel("UEFN DevTools");
  context.subscriptions.push(output);
  const project = await Project.find(output);
  if (!project) {
    output.appendLine("No workspace folder is open; UEFN DevTools is idle.");
    return undefined;
  }
  output.appendLine(`UEFN project root: ${project.root}`);
  context.subscriptions.push(project);

  const tests = new UefnTests(project);
  const compiler = new VerseCompiler(project);
  const events = new EventsProvider(project);
  const state = new StateProvider(project);
  const live = new LiveConnection(project, events, state);
  context.subscriptions.push(tests, compiler, live);
  context.subscriptions.push(
    vscode.window.createTreeView("uefnDevtools.events", { treeDataProvider: events, showCollapseAll: true }),
    vscode.window.createTreeView("uefnDevtools.state", { treeDataProvider: state, showCollapseAll: true }),
  );

  const status = vscode.window.createStatusBarItem("uefnDevtools.status", vscode.StatusBarAlignment.Left, 50);
  status.name = "UEFN DevTools";
  status.command = "uefnDevtools.statusBarAction";
  context.subscriptions.push(status);
  let session: SessionSnapshot | undefined;
  const renderStatus = () => {
    const daemon = project.daemon;
    if (!daemon) {
      status.text = "$(debug-disconnect) UEFN: no daemon";
      status.tooltip = "No UEFN DevTools daemon is running for this project. Click to start one.";
      status.accessibilityInformation = { label: "UEFN DevTools: no daemon running. Activate to start the daemon.", role: "button" };
    } else {
      const sessionText = session?.session ? `session ${session.session.status}` : "no session";
      const phase = session?.session ? `, game ${session.phase}` : "";
      status.text = `$(broadcast) UEFN: ${sessionText}`;
      status.tooltip = `UEFN DevTools daemon on port ${daemon.port} (pid ${daemon.pid}), ${sessionText}${phase}. Click to open the dashboard.`;
      status.accessibilityInformation = {
        label: `UEFN DevTools: daemon running, ${sessionText}${phase}. Activate to open the dashboard.`,
        role: "button",
      };
    }
    status.show();
  };

  context.subscriptions.push(
    project.onDidChangeDaemon(() => {
      session = undefined;
      renderStatus();
      live.sync();
      void vscode.commands.executeCommand("setContext", "uefnDevtools.daemonRunning", project.daemon !== undefined);
    }),
    live.onDidChangeSession((snapshot) => {
      session = snapshot;
      renderStatus();
    }),
  );

  const startDaemon = async () => {
    if (await project.refreshDaemon()) {
      void vscode.window.showInformationMessage(`The UEFN DevTools daemon is already running on port ${project.daemon!.port}.`);
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "UEFN: Starting daemon" }, async () => {
      const { cli, args, result } = await project.run(["daemon", "start", "--detach"]);
      if (result.code !== 0) {
        void vscode.window.showErrorMessage(`Could not start the UEFN daemon: ${describeFailure(cli, args, result)}`);
        return;
      }
      await project.refreshDaemon();
    });
  };

  const stopDaemon = async () => {
    const { cli, args, result } = await project.run(["daemon", "stop"]);
    if (result.code !== 0) void vscode.window.showErrorMessage(`Could not stop the UEFN daemon: ${describeFailure(cli, args, result)}`);
    await project.refreshDaemon();
  };

  /** `uefn ui` may keep running (it hosts the dashboard) or may not exist in older CLIs; report only early failures. */
  const openDashboard = () => {
    const cli = project.cli();
    const args = [...cli.args, "ui", ...project.adapterArgs()];
    output.appendLine(`$ ${[cli.command, ...args].join(" ")}`);
    const child = spawn(cli.command, args, { cwd: project.root, shell: cli.shell ?? false, detached: true, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (error) => {
      void vscode.window.showErrorMessage(describeFailure(cli, ["ui"], { code: null, stdout: "", stderr, cancelled: false, spawnError: error }));
    });
    child.on("exit", (code) => {
      if (code === 0 || code === null) return;
      output.appendLine(stderr.trimEnd());
      const unknown = /unknown command/i.test(stderr);
      void vscode.window.showWarningMessage(
        unknown
          ? "This version of the uefn CLI has no 'ui' command, so the dashboard is not available. Update @uefn-devtools/cli."
          : `The dashboard could not be opened: ${describeFailure(cli, ["ui"], { code, stdout: "", stderr, cancelled: false })}`,
      );
    });
    // Let the dashboard outlive the extension host once it is up.
    setTimeout(() => {
      child.stderr?.destroy();
      child.unref();
    }, 10_000).unref();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("uefnDevtools.compile", () => compiler.compile(true)),
    vscode.commands.registerCommand("uefnDevtools.refreshTests", () => tests.discover()),
    vscode.commands.registerCommand("uefnDevtools.startDaemon", startDaemon),
    vscode.commands.registerCommand("uefnDevtools.stopDaemon", stopDaemon),
    vscode.commands.registerCommand("uefnDevtools.openDashboard", openDashboard),
    vscode.commands.registerCommand("uefnDevtools.refreshState", () => state.refresh()),
    vscode.commands.registerCommand("uefnDevtools.clearEvents", () => events.clear()),
    vscode.commands.registerCommand("uefnDevtools.showOutput", () => output.show()),
    vscode.commands.registerCommand("uefnDevtools.statusBarAction", async () => {
      if (await project.refreshDaemon()) openDashboard();
      else await startDaemon();
    }),
  );

  renderStatus();
  await project.refreshDaemon();
  // refreshDaemon only fires on a change; make sure the context key and views reflect the first read.
  void vscode.commands.executeCommand("setContext", "uefnDevtools.daemonRunning", project.daemon !== undefined);
  if (!project.daemon) live.sync();
  void tests.discover();
  return {
    root: project.root,
    discover: async () => {
      await tests.discover();
      return tests.listedIds();
    },
  };
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}
