import type { ParseArgsOptionsConfig } from "node:util";
import { DevToolsEngine } from "@uefn-devtools/core";

/** Parsed option values; every command reads the subset it declared. */
export type Values = Record<string, string | boolean | string[] | undefined>;

export class UsageError extends Error {}

/** One `uefn <name>` subcommand. Commands live in `./commands/` and register in `./commands/index.ts`. */
export interface Command {
  name: string;
  /** `name [args]` as shown in help. */
  usage: string;
  summary: string;
  options?: ParseArgsOptionsConfig;
  /** Lines describing `options`, shown under "<name> options". */
  optionHelp?: string[];
  run(values: Values, positionals: string[]): Promise<number>;
}

export function str(values: Values, name: string): string | undefined {
  const v = values[name];
  return typeof v === "string" ? v : undefined;
}

export function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} expects an integer`);
  return n;
}

export async function openEngine(values: Values): Promise<DevToolsEngine> {
  const adapter = str(values, "adapter");
  if (adapter !== undefined && adapter !== "simulated" && adapter !== "mcp") {
    throw new UsageError(`unknown adapter '${adapter}'`);
  }
  const config = str(values, "config");
  return DevToolsEngine.open({
    ...(config ? { configPath: config } : {}),
    ...(adapter ? { adapter } : {}),
  });
}

export function print(values: Values, data: unknown, human: () => void): void {
  if (values.json) process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  else human();
}

/** Values of a `multiple: true` option. */
export function list(values: Values, name: string): string[] | undefined {
  const v = values[name];
  return Array.isArray(v) ? v : undefined;
}
