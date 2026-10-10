import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { filterTests, findTestFiles, loadTests } from "@uefn-devtools/test";
import { openEngine, print, type Command } from "../shared.ts";

export interface ListedTest {
  id: string;
  name: string;
  file: string;
  format: "typescript" | "yaml";
  /** 1-based line of the YAML `name:` key or the TS `test("...")` call, when found. */
  line?: number;
  skip?: boolean;
}

export const list: Command = {
  name: "list",
  usage: "list [filter]",
  summary: "List discovered tests without running them",
  async run(values, positionals) {
    const engine = await openEngine(values);
    try {
      const testsDir = resolve(engine.root, engine.config.paths.tests);
      const { tests, errors } = await loadTests(await findTestFiles(testsDir));
      const selected = filterTests(tests, positionals[0]);
      const sources = new Map<string, string>();
      const out: ListedTest[] = [];
      for (const t of selected) {
        let text = sources.get(t.file);
        if (text === undefined) {
          text = await readFile(t.file, "utf8").catch(() => "");
          sources.set(t.file, text);
        }
        const line = findTestLine(text, t.name, t.format);
        out.push({
          id: t.id,
          name: t.name,
          file: t.file,
          format: t.format,
          ...(line !== undefined ? { line } : {}),
          ...(t.skip ? { skip: true } : {}),
        });
      }
      print(values, { root: engine.root, testsDir, tests: out, errors }, () => {
        for (const t of out) {
          const where = `${relative(engine.root, t.file)}${t.line ? `:${t.line}` : ""}`;
          console.log(`${t.id.padEnd(40)} ${t.name}  (${where})`);
        }
        for (const e of errors) console.error(`error   ${relative(engine.root, e.file)}: ${e.message}`);
        console.log(`${out.length} test(s)`);
      });
      return errors.length > 0 ? 1 : 0;
    } finally {
      await engine.close();
    }
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Best-effort source line of a test definition; undefined when there is no match. */
export function findTestLine(text: string, name: string, format: "typescript" | "yaml"): number | undefined {
  const lines = text.split(/\r?\n/);
  if (format === "yaml") {
    const re = /^name:\s*(.*?)\s*$/;
    for (const [i, l] of lines.entries()) {
      const m = re.exec(l);
      if (!m) continue;
      const value = m[1]!.replace(/^(["'])(.*)\1$/, "$2");
      if (value === name) return i + 1;
    }
    return undefined;
  }
  const re = new RegExp(`\\btest(?:\\.(?:skip|only))?\\(\\s*(["'\`])${escapeRegExp(name)}\\1`);
  const idx = lines.findIndex((l) => re.test(l));
  return idx >= 0 ? idx + 1 : undefined;
}
