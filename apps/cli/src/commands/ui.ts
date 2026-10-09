import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { DaemonClient, readDaemonInfo, type DaemonInfo } from "@uefn-devtools/daemon";
import { desktopUiBuilt } from "@uefn-devtools/desktop";
import { openEngine, print, UsageError, type Command } from "../shared.ts";
import { startDetached } from "./daemon.ts";

export const ui: Command = {
  name: "ui",
  usage: "ui [--no-open] [--port n]",
  summary: "Open the DevTools dashboard (starts a daemon with the UI if needed)",
  options: { "no-open": { type: "boolean" } },
  optionHelp: ["--no-open              print the dashboard URL without opening a window"],
  async run(values) {
    if (!desktopUiBuilt()) throw new UsageError("the desktop UI is not built; run 'pnpm build' first");
    const root = (await openEngine(values)).root;
    let info = await liveDaemon(root);
    if (info && !(await servesUi(info))) {
      console.error(
        `A daemon without the dashboard is already running (pid ${info.pid}, port ${info.port}).\n` +
          "Stop it with 'uefn daemon stop' and run 'uefn ui' again, or start it with 'uefn daemon start --ui'.",
      );
      return 1;
    }
    if (!info) {
      const code = await startDetached({ ...values, ui: true }, !!values.json);
      if (code !== 0) return code;
      info = await liveDaemon(root);
      if (!info) {
        console.error("the daemon started but daemon.json is missing");
        return 1;
      }
    }
    // The URL holds a single-use launch ticket, never the token itself: it is
    // printed, and passed on a browser command line other processes can read.
    const { ticket } = await DaemonClient.fromInfo(info, "cli").uiTicket();
    const url = `http://127.0.0.1:${info.port}/#ticket=${encodeURIComponent(ticket)}`;
    const opened = values["no-open"] ? undefined : openAppWindow(url);
    print(values, { url, pid: info.pid, port: info.port, opened: opened ?? null }, () => {
      console.log(`Dashboard ${url}`);
      if (opened) console.log(`Opened with ${opened}`);
      else if (!values["no-open"]) console.log("Could not find a browser to open; open the URL above.");
    });
    return 0;
  },
};

async function liveDaemon(root: string): Promise<DaemonInfo | undefined> {
  const info = await readDaemonInfo(root);
  return info && !info.stale ? info : undefined;
}

/** daemon.json says so for new daemons; older ones are asked directly. */
async function servesUi(info: DaemonInfo): Promise<boolean> {
  if (info.ui !== undefined) return info.ui;
  try {
    return (await DaemonClient.fromInfo(info, "cli").status()).daemon.ui === true;
  } catch {
    return false;
  }
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Chromium-family browsers that support `--app=<url>` (a window without tabs or address bar), most preferred first. */
function appBrowsers(): string[] {
  const linux = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"]
    .map(onPath)
    .filter((p): p is string => !!p);
  switch (process.platform) {
    case "win32": {
      const bases = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LOCALAPPDATA"]].filter(
        (b): b is string => !!b,
      );
      return bases
        .flatMap((b) => [join(b, "Google", "Chrome", "Application", "chrome.exe"), join(b, "Microsoft", "Edge", "Application", "msedge.exe")])
        .filter((p) => existsSync(p));
    }
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ].filter((p) => existsSync(p));
    default: {
      // Under WSL a Linux Chrome (WSLg) shares the loopback interface; Windows browsers are the fallback.
      const windows = isWsl()
        ? [
            "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
            "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
            "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
            "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
          ].filter((p) => existsSync(p))
        : [];
      return [...linux, ...windows];
    }
  }
}

function launch(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

/** Opens `url` in an app window, else in the default browser. Returns what was used, or undefined. */
export function openAppWindow(url: string): string | undefined {
  const browser = appBrowsers()[0];
  if (browser) {
    launch(browser, [`--app=${url}`]);
    return browser;
  }
  if (process.platform === "darwin") {
    launch("open", [url]);
    return "open";
  }
  if (process.platform === "win32") {
    // The empty string is the window title argument of `start`.
    launch("cmd", ["/c", "start", "", url]);
    return "start";
  }
  const opener = (isWsl() ? onPath("wslview") : undefined) ?? onPath("xdg-open");
  if (opener) {
    launch(opener, [url]);
    return opener;
  }
  return undefined;
}
