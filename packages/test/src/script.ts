import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { StepSchema, type Step } from "./yaml.ts";

const Script = z.union([z.array(StepSchema), z.object({ setup: z.array(StepSchema).default([]), steps: z.array(StepSchema).default([]) })]);

/**
 * Loads a step script for `uefn record --script`: either a bare list of
 * steps or a test-shaped document (its `setup` then `steps` run in order;
 * assertions are ignored).
 */
export async function loadStepScript(file: string): Promise<Step[]> {
  const result = Script.safeParse(parse(await readFile(file, "utf8")));
  if (!result.success) {
    const issues = result.error.issues.map((x) => `  ${x.path.join(".")}: ${x.message}`).join("\n");
    throw new Error(`${file} is not a valid step script:\n${issues}`);
  }
  return Array.isArray(result.data) ? result.data : [...result.data.setup, ...result.data.steps];
}
