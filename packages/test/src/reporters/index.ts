import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { consoleReporter } from "../reporter.ts";
import type { RunnerEvent } from "../runner.ts";
import { githubReporter } from "./github.ts";
import { DEFAULT_JUNIT_PATH, junitReporter } from "./junit.ts";

export { escapeXml, renderJunit, junitReporter, DEFAULT_JUNIT_PATH } from "./junit.ts";
export {
  escapeData,
  escapeProperty,
  workflowCommand,
  renderAnnotations,
  renderGithubLog,
  githubReporter,
  type GithubOptions,
} from "./github.ts";
export { renderMarkdown, escapeCell, COMMENT_MARKER, type MarkdownOptions } from "./markdown.ts";

export const REPORTER_NAMES = ["console", "json", "junit", "github"] as const;
export type ReporterName = (typeof REPORTER_NAMES)[number];

/** Parses repeated and/or comma-separated `--reporter` values. */
export function parseReporterNames(values: string[]): ReporterName[] {
  const names: ReporterName[] = [];
  for (const raw of values.flatMap((v) => v.split(","))) {
    const name = raw.trim();
    if (!name) continue;
    if (!(REPORTER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`unknown reporter '${name}' (expected ${REPORTER_NAMES.join(", ")})`);
    }
    if (!names.includes(name as ReporterName)) names.push(name as ReporterName);
  }
  return names;
}

export interface ReporterSetOptions {
  /** Values of `--reporter`. */
  reporters?: string[];
  /** Value of `--output`: file for junit (or json when junit is not selected). */
  output?: string;
  /** Project root, for resolving relative output paths and annotation files. */
  root?: string;
  verbose?: boolean;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  /**
   * stdout carries a JSON document (`--json`): reporters write to stderr by default
   * and the `json` reporter is skipped since the caller prints the summary itself.
   */
  stdoutJson?: boolean;
}

/** The combined `onEvent` handler, plus the reporter failures seen so far. */
export type ReporterHandler = ((event: RunnerEvent) => void) & {
  /** One message per reporter that threw (unwritable output file, step summary, ...). */
  readonly failures: string[];
};

/**
 * Builds one `onEvent` from the selected reporters. Defaults to console, and adds
 * github when GITHUB_ACTIONS=true. `json` replaces console output with the summary
 * on stdout (or in `--output` when junit is not selected).
 */
export function createReporters(options: ReporterSetOptions = {}): ReporterHandler {
  const env = options.env ?? process.env;
  const names = parseReporterNames(options.reporters ?? []);
  if (names.length === 0) names.push("console");
  if (env["GITHUB_ACTIONS"] === "true" && !names.includes("github")) names.push("github");
  const root = options.root ?? process.cwd();
  const write = options.write ?? ((t: string) => (options.stdoutJson ? process.stderr : process.stdout).write(t));
  const handlers: ((event: RunnerEvent) => void)[] = [];
  for (const name of names) {
    switch (name) {
      case "console":
        handlers.push(consoleReporter({ verbose: options.verbose === true, write }));
        break;
      case "github":
        handlers.push(githubReporter({ root, write, env }));
        break;
      case "junit":
        handlers.push(
          junitReporter({
            file: options.output ?? DEFAULT_JUNIT_PATH,
            cwd: root,
            onWrite: (file) => write(`JUnit: ${file}\n`),
          }),
        );
        break;
      case "json":
        if (options.stdoutJson && !options.output) break;
        handlers.push((event) => {
          if (event.kind !== "done") return;
          const body = JSON.stringify(event.summary, null, 2) + "\n";
          if (options.output && !names.includes("junit")) {
            const path = resolve(root, options.output);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, body);
          } else {
            write(body);
          }
        });
        break;
    }
  }
  const failures: string[] = [];
  const handler = (event: RunnerEvent): void => {
    for (const h of handlers) {
      try {
        h(event);
      } catch (err) {
        const message = (err as Error).message;
        failures.push(message);
        process.stderr.write(`error: reporter failed: ${message}\n`);
      }
    }
  };
  return Object.assign(handler, { failures });
}
