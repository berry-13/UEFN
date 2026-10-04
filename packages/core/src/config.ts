import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DevToolsConfig } from "@uefn-devtools/protocol";
import { parse } from "yaml";

export const CONFIG_FILE = "uefn-devtools.config.yaml";

export interface LoadedConfig {
  config: DevToolsConfig;
  /** Directory relative paths resolve against. */
  root: string;
  /** Absolute config path, when a file was found. */
  file?: string;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Walks up from `cwd` looking for the config; falls back to defaults rooted at `cwd`. */
export async function findConfig(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (await exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(cwd: string, explicitPath?: string): Promise<LoadedConfig> {
  const file = explicitPath ? resolve(cwd, explicitPath) : await findConfig(cwd);
  if (!file) return { config: DevToolsConfig.parse({}), root: resolve(cwd) };
  const raw = parse(await readFile(file, "utf8")) ?? {};
  const result = DevToolsConfig.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid ${file}:\n${issues}`);
  }
  return { config: result.data, root: dirname(file), file };
}
