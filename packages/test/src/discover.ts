import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TEST_FILE, walk } from "@uefn-devtools/core";
import { globalState, type TestDefinition } from "./context.ts";

// Node caches ES modules: importing a test file twice registers nothing the
// second time, and an edited helper would never reload. Long-lived processes
// (daemon, MCP server) therefore version the project's module graph: a
// resolve hook (reload-hook.ts) appends a generation to every project-local
// module URL, and the generation is bumped whenever any script in the
// project changes. Definitions are cached per file for the current
// generation. Imports are serialised because test registration goes through
// one shared registry.
interface ModuleState {
  cache: Map<string, TestDefinition[]>;
  fingerprint?: string;
  generation?: Int32Array;
  hookInstalled: boolean;
  lock: Promise<unknown>;
}
const KEY = Symbol.for("uefn-devtools.test.module-state");
const g = globalThis as unknown as Record<symbol, ModuleState | undefined>;
const state: ModuleState = (g[KEY] ??= { cache: new Map(), hookInstalled: false, lock: Promise.resolve() });

function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = state.lock.then(fn, fn);
  state.lock = next.catch(() => {});
  return next;
}

async function installHook(): Promise<void> {
  if (state.hookInstalled) return;
  state.hookInstalled = true;
  const { register } = await import("node:module");
  if (typeof register !== "function") return; // e.g. other runtimes: entry-only cache busting below
  const buffer = new SharedArrayBuffer(4);
  state.generation = new Int32Array(buffer);
  // DevTools' own packages (the monorepo's packages/ dir, or the installed
  // scope) must keep a single instance.
  const packagesDir = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  register(new URL("./reload-hook.js", import.meta.url), {
    data: { generation: buffer, exclude: [pathToFileURL(packagesDir).href + "/"] },
  });
}

const SCRIPT = /\.(ts|mts|cts|js|mjs|cjs)$/;

/** Changes whenever a script anywhere in the project is added, removed or edited. */
async function fingerprint(root: string): Promise<string> {
  const files = await walk(root, (name) => SCRIPT.test(name));
  const parts = await Promise.all(files.map(async (f) => `${f}:${(await stat(f).catch(() => ({ mtimeMs: 0 }))).mtimeMs}`));
  return createHash("sha1").update(parts.sort().join("\n")).digest("hex");
}

/** Bumps the generation when the project changed; once per discovery, not per file. */
async function refreshGeneration(root: string): Promise<string> {
  await installHook();
  const print = await fingerprint(root);
  if (print !== state.fingerprint) {
    if (state.fingerprint !== undefined && state.generation) Atomics.add(state.generation, 0, 1);
    state.fingerprint = print;
    state.cache.clear();
  }
  return print;
}

/** Caller holds the discovery lock and has refreshed the generation. */
async function importTestModule(file: string, print: string): Promise<TestDefinition[]> {
  const cached = state.cache.get(file);
  if (cached) return cached;
  const before = globalState.registry.length;
  globalState.loadingFile = file;
  try {
    const url = pathToFileURL(file);
    // Without the hook, at least bust the entry module (helpers stay cached).
    if (!state.generation) url.searchParams.set("v", print);
    await import(url.href);
  } catch (error) {
    globalState.registry.splice(before);
    throw error;
  } finally {
    globalState.loadingFile = undefined;
  }
  const tests = globalState.registry.splice(before);
  state.cache.set(file, tests);
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

export interface LoadOptions {
  /**
   * Project root: an edit to any script under it reloads the test modules.
   * Defaults to the common directory of the test files.
   */
  root?: string;
}

function commonDir(files: readonly string[]): string {
  if (files.length === 0) return process.cwd();
  let dir = dirname(resolve(files[0]!));
  while (!files.every((f) => resolve(f).startsWith(dir + "/") || resolve(f).startsWith(dir + "\\"))) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

/** Loads TypeScript tests through Node's type stripping and YAML tests through the schema. */
export async function loadTests(files: readonly string[], options: LoadOptions = {}): Promise<DiscoveryResult> {
  const root = resolve(options.root ?? commonDir(files));
  const tests: TestDefinition[] = [];
  const errors: DiscoveryResult["errors"] = [];
  const tsFiles = files.filter((f) => !/\.ya?ml$/.test(f));
  // One lock and one project fingerprint for the whole discovery.
  const imported = tsFiles.length
    ? await serialised(async () => {
        const print = await refreshGeneration(root);
        const out = new Map<string, TestDefinition[] | Error>();
        for (const file of tsFiles) {
          out.set(file, await importTestModule(file, print).catch((e: Error) => e));
        }
        return out;
      })
    : new Map<string, TestDefinition[] | Error>();
  for (const file of files) {
    try {
      if (/\.ya?ml$/.test(file)) {
        tests.push(...(await loadYamlTests(file)));
      } else {
        const result = imported.get(file)!;
        if (result instanceof Error) throw result;
        tests.push(...result);
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
