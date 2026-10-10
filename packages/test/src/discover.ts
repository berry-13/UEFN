import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TEST_FILE, walk } from "@uefn-devtools/core";
import { globalState, type TestDefinition } from "./context.ts";
import { loadYamlTests } from "./yaml.ts";

export interface DiscoveryResult {
  tests: TestDefinition[];
  errors: { file: string; message: string }[];
}

export async function findTestFiles(testsDir: string): Promise<string[]> {
  return walk(resolve(testsDir), (name) => TEST_FILE.test(name));
}

/**
 * ES modules are cached for the life of the process, so importing a test file
 * a second time registers nothing. Long-lived hosts (the daemon) load tests
 * repeatedly: keep each file's definitions and re-import only when it changed.
 */
const loaded = new Map<string, { mtimeMs: number; tests: TestDefinition[]; failed?: boolean }>();

/** Loads TypeScript tests through Node's type stripping and YAML tests through the schema. */
export async function loadTests(files: readonly string[]): Promise<DiscoveryResult> {
  const tests: TestDefinition[] = [];
  const errors: DiscoveryResult["errors"] = [];
  for (const file of files) {
    try {
      if (/\.ya?ml$/.test(file)) {
        tests.push(...(await loadYamlTests(file)));
      } else {
        const { mtimeMs } = await stat(file);
        const cached = loaded.get(file);
        if (cached && !cached.failed && cached.mtimeMs === mtimeMs) {
          tests.push(...cached.tests);
          continue;
        }
        const before = globalState.registry.length;
        globalState.loadingFile = file;
        const url = pathToFileURL(file);
        // A changed or previously failed file gets a fresh module instance; the first load keeps the plain URL.
        if (cached) url.search = `?mtime=${mtimeMs}`;
        try {
          await import(url.href);
        } catch (error) {
          // A module that throws at load stays cached by Node; remember it so the
          // next load (after the file is fixed) gets a fresh URL.
          globalState.registry.splice(before);
          loaded.set(file, { mtimeMs, tests: [], failed: true });
          throw error;
        } finally {
          globalState.loadingFile = undefined;
        }
        const defs = globalState.registry.splice(before);
        loaded.set(file, { mtimeMs, tests: defs });
        tests.push(...defs);
      }
    } catch (error) {
      errors.push({ file, message: (error as Error).message });
    }
  }
  return { tests, errors };
}

export function filterTests(tests: readonly TestDefinition[], filter?: string): TestDefinition[] {
  const only = tests.filter((t) => t.only);
  const pool = only.length > 0 ? only : tests;
  if (!filter) return [...pool];
  const needle = filter.toLowerCase();
  return pool.filter(
    (t) => t.id.includes(needle) || t.name.toLowerCase().includes(needle) || t.file.toLowerCase().includes(needle),
  );
}
