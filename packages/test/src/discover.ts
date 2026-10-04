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

/** Loads TypeScript tests through Node's type stripping and YAML tests through the schema. */
export async function loadTests(files: readonly string[]): Promise<DiscoveryResult> {
  const tests: TestDefinition[] = [];
  const errors: DiscoveryResult["errors"] = [];
  for (const file of files) {
    try {
      if (/\.ya?ml$/.test(file)) {
        tests.push(...(await loadYamlTests(file)));
      } else {
        const before = globalState.registry.length;
        globalState.loadingFile = file;
        try {
          await import(pathToFileURL(file).href);
        } finally {
          globalState.loadingFile = undefined;
        }
        tests.push(...globalState.registry.splice(before));
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
