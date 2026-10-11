import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitInfo } from "@uefn-devtools/protocol";

const run = promisify(execFile);

async function gitRaw(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return undefined;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  return (await gitRaw(cwd, ...args))?.trim();
}

/**
 * Parses `git status --porcelain=v1 -z` output. Entries are `XY path` separated by NUL;
 * a rename or copy is followed by an extra entry holding the old path. Both paths are
 * kept so impact analysis sees the file that disappeared as well as the one that appeared.
 */
export function parsePorcelainZ(output: string): string[] {
  const parts = output.split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && parts[i + 1]) files.push(parts[++i]!);
  }
  return files;
}

/** Captured with every session so results can be tied to a revision (spec §57). */
export async function captureGitInfo(cwd: string): Promise<GitInfo | undefined> {
  const inside = await git(cwd, "rev-parse", "--is-inside-work-tree");
  if (inside !== "true") return undefined;
  const [commit, branch, status] = await Promise.all([
    git(cwd, "rev-parse", "--short", "HEAD"),
    git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
    gitRaw(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
  ]);
  const changedFiles = parsePorcelainZ(status ?? "");
  return {
    ...(commit ? { commit } : {}),
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    dirty: changedFiles.length > 0,
    changedFiles,
  };
}
