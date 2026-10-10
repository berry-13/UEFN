import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonInfo } from "./api.ts";

export function daemonInfoPath(root: string): string {
  return join(root, ".devtools", "daemon.json");
}

export function daemonLockPath(root: string): string {
  return join(root, ".devtools", "daemon.lock");
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

/**
 * True when the daemon described by `info` answers `GET /api/status` with its
 * token. A running pid alone is not proof: the OS may have reused it.
 */
export async function probeDaemon(info: Pick<DaemonInfo, "port" | "token">, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/status`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
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

/** How long a lock counts as a start in progress before an answering daemon must stand behind it. */
const LOCK_GRACE_MS = 30_000;

interface LockContents {
  pid: number;
  /** Distinguishes two holders in one process (tests, embedding). */
  nonce: string;
}

/** Exclusive per-project start lock, held for the daemon's lifetime. */
export interface DaemonLock {
  release(): Promise<void>;
}

/**
 * Takes `<root>/.devtools/daemon.lock` with an exclusive create, so two
 * concurrent starts cannot both succeed. A lock whose holder is gone (dead
 * pid, or an old lock with no answering daemon behind it) is taken over once.
 */
export async function acquireDaemonLock(root: string): Promise<DaemonLock> {
  const path = daemonLockPath(root);
  await mkdir(join(root, ".devtools"), { recursive: true });
  const contents: LockContents = { pid: process.pid, nonce: randomBytes(8).toString("hex") };
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(contents) + "\n");
      } finally {
        await handle.close();
      }
      return { release: () => releaseLock(path, contents.nonce) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await readLock(path);
    if (attempt > 0 || !(await lockIsStale(root, path, holder))) {
      throw new Error(`a daemon is already running or starting for ${root}${holder ? ` (pid ${holder.pid})` : ""}`);
    }
    await rm(path, { force: true });
  }
}

async function readLock(path: string): Promise<LockContents | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as LockContents;
    return typeof parsed.pid === "number" && typeof parsed.nonce === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function lockIsStale(root: string, path: string, holder: LockContents | undefined): Promise<boolean> {
  if (holder && !isProcessAlive(holder.pid)) return true;
  if (holder) {
    const info = await readDaemonInfo(root);
    if (info && info.pid === holder.pid && (await probeDaemon(info))) return false;
  }
  // No answering daemon behind it (or a half-written lock): a start still in
  // progress while young, a crashed start or a reused pid once old.
  const created = await stat(path).then((s) => s.mtimeMs, () => 0);
  return Date.now() - created > LOCK_GRACE_MS;
}

async function releaseLock(path: string, nonce: string): Promise<void> {
  const holder = await readLock(path);
  if (holder && holder.nonce !== nonce) return;
  await rm(path, { force: true });
}
