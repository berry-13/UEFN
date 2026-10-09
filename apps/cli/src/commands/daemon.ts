import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DaemonClient,
  DevToolsDaemon,
  daemonInfoPath,
  isProcessAlive,
  readDaemonInfo,
  removeDaemonInfo,
} from "@uefn-devtools/daemon";
import { desktopStaticDir, desktopUiBuilt } from "@uefn-devtools/desktop";
import { int, openEngine, print, str, UsageError, type Command, type Values } from "../shared.ts";

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

export const daemon: Command = {
  name: "daemon",
  usage: "daemon <start|stop|status>",
  summary: "Local daemon: one shared engine and session for CLI, desktop and editor",
  options: { port: { type: "string" }, detach: { type: "boolean" }, ui: { type: "boolean" } },
  optionHelp: [
    "--port <n>             TCP port on 127.0.0.1 (default: ephemeral)",
    "--detach               start in the background and return once it is listening",
    "--ui                   also serve the desktop dashboard under / (see 'uefn ui')",
  ],
  async run(values, positionals) {
    switch (positionals[0]) {
      case "start":
        return values.detach ? startDetached(values) : startForeground(values);
      case "stop":
        return stop(values);
      case "status":
        return status(values);
      default:
        throw new UsageError("usage: uefn daemon <start|stop|status> [--port n] [--detach] [--ui]");
    }
  },
};

async function projectRoot(values: Values): Promise<string> {
  return (await openEngine(values)).root;
}

async function startForeground(values: Values): Promise<number> {
  const port = int(str(values, "port"), "port") ?? 0;
  if (values.ui && !desktopUiBuilt()) throw new UsageError("the desktop UI is not built; run 'pnpm build' first");
  const engine = await openEngine(values);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop().catch(() => {});
    await engine.close().catch(() => {});
    process.exit(0);
  };
  const server = new DevToolsDaemon({
    engine,
    port,
    ...(values.ui ? { staticDir: desktopStaticDir() } : {}),
    onShutdown: () => void shutdown(),
  });
  const info = await server.start();
  print(values, { pid: info.pid, port: info.port, root: info.root, startedAt: info.startedAt, version: info.version }, () => {
    console.log(`DevTools daemon listening on http://127.0.0.1:${info.port} (pid ${info.pid})`);
    if (info.ui) console.log("Dashboard served under /; 'uefn ui' opens it with the token");
    console.log(`Project   ${info.root}`);
    console.log(`Token     in ${daemonInfoPath(info.root)}`);
    console.log("Ctrl+C to stop");
  });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return new Promise<number>(() => {});
}

/** `quiet` skips the success output (callers such as `uefn ui` print their own). */
export async function startDetached(values: Values, quiet = false): Promise<number> {
  const root = await projectRoot(values);
  const existing = await readDaemonInfo(root);
  if (existing && !existing.stale) {
    console.error(`daemon already running (pid ${existing.pid}, port ${existing.port})`);
    return 1;
  }
  await mkdir(join(root, ".devtools"), { recursive: true });
  const logPath = join(root, ".devtools", "daemon.log");
  const log = openSync(logPath, "a");
  const args = [process.argv[1]!, "daemon", "start"];
  if (values.ui) args.push("--ui");
  for (const name of ["port", "adapter"] as const) {
    const v = str(values, name);
    if (v !== undefined) args.push(`--${name}`, v);
  }
  const config = str(values, "config");
  if (config !== undefined) args.push("--config", resolve(config));
  const child = spawn(process.execPath, [...process.execArgv, ...args], {
    detached: true,
    stdio: ["ignore", log, log],
    cwd: process.cwd(),
    windowsHide: true,
  });
  closeSync(log);
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? 1));
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await readDaemonInfo(root);
    if (info && info.pid === child.pid) {
      if (quiet) return 0;
      print(values, { pid: info.pid, port: info.port, root: info.root, log: logPath }, () => {
        console.log(`DevTools daemon started on http://127.0.0.1:${info.port} (pid ${info.pid})`);
        console.log(`Log       ${logPath}`);
      });
      return 0;
    }
    if (exited !== null) {
      console.error(`daemon exited with code ${exited} before it was ready; see ${logPath}`);
      return 1;
    }
    await delay(100);
  }
  console.error(`daemon did not write ${daemonInfoPath(root)} within ${START_TIMEOUT_MS / 1000}s; see ${logPath}`);
  return 1;
}

async function stop(values: Values): Promise<number> {
  const root = await projectRoot(values);
  const info = await readDaemonInfo(root);
  if (!info) {
    console.log("No daemon is running.");
    return 0;
  }
  if (info.stale) {
    await removeDaemonInfo(root, info.pid);
    console.log(`Removed stale daemon.json (pid ${info.pid} was not running).`);
    return 0;
  }
  try {
    await DaemonClient.fromInfo(info, "cli").shutdown();
  } catch {
    process.kill(info.pid, "SIGTERM");
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && isProcessAlive(info.pid)) await delay(100);
  if (isProcessAlive(info.pid)) {
    console.error(`daemon (pid ${info.pid}) did not exit within ${STOP_TIMEOUT_MS / 1000}s`);
    return 1;
  }
  await removeDaemonInfo(root, info.pid);
  console.log(`Stopped daemon (pid ${info.pid}).`);
  return 0;
}

async function status(values: Values): Promise<number> {
  const root = await projectRoot(values);
  const info = await readDaemonInfo(root);
  if (!info || info.stale) {
    const data = { running: false, ...(info ? { stale: true, pid: info.pid } : {}) };
    print(values, data, () =>
      console.log(info ? `Not running (stale daemon.json, pid ${info.pid}; 'uefn daemon stop' removes it)` : "Not running"),
    );
    return 1;
  }
  const s = await DaemonClient.fromInfo(info, "cli").status();
  print(values, { running: true, ...s }, () => {
    console.log(`Daemon    http://127.0.0.1:${s.daemon.port} (pid ${s.daemon.pid}, v${s.daemon.version})`);
    console.log(`Project   ${s.project} (${s.root})`);
    console.log(`Adapter   ${s.adapter}`);
    console.log(`Session   ${s.session ? `${s.session.id} ${s.session.status}` : "none"}${s.runtimeReady ? " (runtime ready)" : ""}`);
    console.log(`Phase     ${s.phase}`);
    console.log(`Events    ${s.events}`);
    console.log(`Clients   ${s.daemon.streams} stream(s)${s.busy ? ", busy" : ""}`);
  });
  return 0;
}
