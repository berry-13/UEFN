// Writes schemas/yaml-test.schema.json from YamlTestSchema (packages/test/src/yaml.ts).
// Run after `pnpm build`: `pnpm --filter uefn-devtools-vscode gen:schema`.
// test/schema.test.ts fails when the committed file drifts from the schema.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { yamlTestJsonSchema } from "./schema-source.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "yaml-test.schema.json");
await writeFile(out, JSON.stringify(await yamlTestJsonSchema(), null, 2) + "\n");
console.log(`wrote ${out}`);
