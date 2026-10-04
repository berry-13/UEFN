import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TEST_FILE, walk } from "@uefn-devtools/core";
import { globalState, type TestDefinition } from "./context.ts";

// Node caches ES modules, so importing a test file twice registers nothing
// the second time. Long-lived processes (daemon, MCP server) keep the
// definitions per file and re-import, with a cache-busting query, only when
// the file has changed.
const KEY = Symbol.for("uefn-devtools.test.module-cache");
const g = globalThis as unknown as Record<symbol, Map<string, { mtimeMs: number; tests: TestDefinition[] }> | undefined>;
const moduleCache = (g[KEY] ??= new Map());

async function importTestModule(file: string): Promise<TestDefinition[]> {
  const { mtimeMs } = await stat(file);
  const cached = moduleCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.tests;
  const before = globalState.registry.length;
  globalState.loadingFile = file;
  try {
    const url = pathToFileURL(file);
    if (cached) url.searchParams.set("v", String(mtimeMs));
    await import(url.href);
  } catch (error) {
    globalState.registry.splice(before);
    throw error;
  } finally {
    globalState.loadingFile = undefined;
  }
  const tests = globalState.registry.splice(before);
  moduleCache.set(file, { mtimeMs, tests });
  return tests;
}
import { loadYamlTests } from "./yaml.ts";

export interface DiscoveryResult {
  tests: TestDefinition[];
  errors: { file: string; message: string }[];
}

export async function findTestFiles(testsDir: string): Promise<string[]> {
  return walk(resolve(testsDir), (name) => TEST_FILE.test(name));
}

/** Loads TypeScript tests through Node's type stripping and YAML tests through the schema. */
export async function loadTests(files: readonly string[]): Promise<DiscoveryResult> {
  const tests: TestDefinition[] = [];
  const errors: DiscoveryResult["errors"] = [];
  for (const file of files) {
    try {
      if (/\.ya?ml$/.test(file)) {
        tests.push(...(await loadYamlTests(file)));
      } else {
        tests.push(...(await importTestModule(file)));
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
