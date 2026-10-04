import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { Project } from "@uefn-devtools/protocol";
import type { LoadedConfig } from "./config.ts";

const IGNORED_DIRS = new Set(["node_modules", ".git", ".devtools", "dist", "Intermediate", "Saved"]);

export async function walk(dir: string, accept: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await visit(full);
      } else if (accept(entry.name)) out.push(full);
    }
  }
  await visit(dir);
  return out;
}

export const TEST_FILE = /\.test\.(ts|mts|yaml|yml)$/;

/** Project discovery (MVP item 1). Paths in the result are relative to the project root. */
export async function discoverProject(loaded: LoadedConfig): Promise<Project> {
  const { root, config } = loaded;
  const entries = await readdir(root).catch(() => [] as string[]);
  const projectFile = entries.find((e) => e.endsWith(".uefnproject"));
  const verseFiles = await walk(resolve(root, config.paths.verse), (n) => n.endsWith(".verse"));
  const testFiles = await walk(resolve(root, config.paths.tests), (n) => TEST_FILE.test(n));
  return {
    name: config.project.name ?? (projectFile ? projectFile.replace(/\.uefnproject$/, "") : basename(root)),
    root,
    ...(projectFile ? { projectFile } : {}),
    verseFiles: verseFiles.map((f) => relative(root, f)),
    testFiles: testFiles.map((f) => relative(root, f)),
  };
}
