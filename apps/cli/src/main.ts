#!/usr/bin/env node
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { CONFIG_FILE } from "@uefn-devtools/core";
import { commands } from "./commands/index.ts";
import { UsageError, type Values } from "./shared.ts";

const GLOBAL_OPTIONS: ParseArgsOptionsConfig = {
  adapter: { type: "string" },
  config: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

function help(): string {
  const width = Math.max(...commands.map((c) => c.usage.length)) + 3;
  const lines = [
    "uefn — UEFN DevTools",
    "",
    "Usage: uefn <command> [options]",
    "",
    "Commands",
    ...commands.map((c) => `  ${c.usage.padEnd(width)}${c.summary}`),
    "",
    "Global options",
    "  --adapter <name>       simulated | mcp (overrides config)",
    `  --config <path>        Config file (default: nearest ${CONFIG_FILE})`,
    "  --json                 Machine-readable output",
  ];
  for (const c of commands) {
    if (!c.optionHelp?.length) continue;
    lines.push("", `${c.name} options`, ...c.optionHelp.map((l) => `  ${l}`));
  }
  return lines.join("\n") + "\n";
}

function parse(argv: string[]): { command?: string; positionals: string[]; values: Values } {
  const options: ParseArgsOptionsConfig = { ...GLOBAL_OPTIONS };
  for (const c of commands) Object.assign(options, c.options);
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options });
  const [command, ...rest] = positionals;
  return { ...(command ? { command } : {}), positionals: rest, values: values as Values };
}

async function main(): Promise<number> {
  const { command, positionals, values } = parse(process.argv.slice(2));
  if (!command || values.help) {
    process.stdout.write(help());
    return command ? 0 : values.help ? 0 : 2;
  }
  const found = commands.find((c) => c.name === command);
  if (!found) throw new UsageError(`unknown command '${command}'\n\n${help()}`);
  return found.run(values, positionals);
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(error instanceof UsageError ? error.message : `error: ${error.message}`);
    process.exit(2);
  },
);
