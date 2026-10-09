import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonInfo } from "./api.ts";

export function daemonInfoPath(root: string): string {
  return join(root, ".devtools", "daemon.json");
}

/** True when a process with `pid` exists (EPERM means it exists but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Reads `<root>/.devtools/daemon.json`. Returns undefined when there is no
 * (readable) file; `stale` is true when the recorded pid is no longer running.
 */
export async function readDaemonInfo(root: string): Promise<(DaemonInfo & { stale: boolean }) | undefined> {
  let raw: string;
  try {
    raw = await readFile(daemonInfoPath(root), "utf8");
  } catch {
    return undefined;
  }
  let info: DaemonInfo;
  try {
    info = JSON.parse(raw) as DaemonInfo;
  } catch {
    return undefined;
  }
  if (typeof info.pid !== "number" || typeof info.port !== "number" || typeof info.token !== "string") return undefined;
  return { ...info, stale: !isProcessAlive(info.pid) };
}

/** Writes daemon.json atomically with mode 0600 (it holds the bearer token). */
export async function writeDaemonInfo(info: DaemonInfo): Promise<void> {
  const path = daemonInfoPath(info.root);
  await mkdir(join(info.root, ".devtools"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** Removes daemon.json, but only if it still describes `pid` (never another daemon's file). */
export async function removeDaemonInfo(root: string, pid: number): Promise<void> {
  const current = await readDaemonInfo(root);
  if (current && current.pid !== pid) return;
  await rm(daemonInfoPath(root), { force: true });
}
