import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const schemaFile = join(import.meta.dirname, "..", "schemas", "yaml-test.schema.json");

test("the shipped YAML test schema matches YamlTestSchema (run `pnpm --filter uefn-devtools-vscode gen:schema`)", async () => {
  const { yamlTestJsonSchema } = await import("../scripts/schema-source.mjs");
  const committed = JSON.parse(await readFile(schemaFile, "utf8"));
  assert.deepEqual(committed, await yamlTestJsonSchema());
});

test("the schema rejects unknown keys and requires a name", async () => {
  const schema = JSON.parse(await readFile(schemaFile, "utf8"));
  assert.deepEqual(schema.required, ["name"]);
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.steps && schema.properties.assert && schema.properties.setup);
});

test("package.json contributes the schema for *.test.yaml", async () => {
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"));
  const entry = pkg.contributes.yamlValidation[0];
  assert.ok(entry.fileMatch.includes("*.test.yaml"));
  assert.equal(entry.url, "./schemas/yaml-test.schema.json");
});
