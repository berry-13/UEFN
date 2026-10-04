import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitInfo } from "@uefn-devtools/protocol";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 5000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Captured with every session so results can be tied to a revision (spec §57). */
export async function captureGitInfo(cwd: string): Promise<GitInfo | undefined> {
  const inside = await git(cwd, "rev-parse", "--is-inside-work-tree");
  if (inside !== "true") return undefined;
  const [commit, branch, status] = await Promise.all([
    git(cwd, "rev-parse", "--short", "HEAD"),
    git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
    git(cwd, "status", "--porcelain"),
  ]);
  const changedFiles = (status ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3));
  return {
    ...(commit ? { commit } : {}),
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    dirty: changedFiles.length > 0,
    changedFiles,
  };
}
