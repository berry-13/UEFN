import assert from "node:assert/strict";
import { test } from "node:test";
import { findTestLine } from "../src/commands/list.ts";

test("findTestLine finds YAML name keys per document, quoted or not", () => {
  const yaml = 'name: First\nsteps: []\n---\nname: "Second (b)"\n';
  assert.equal(findTestLine(yaml, "First", "yaml"), 1);
  assert.equal(findTestLine(yaml, "Second (b)", "yaml"), 4);
  assert.equal(findTestLine(yaml, "Missing", "yaml"), undefined);
});

test("findTestLine finds test(), test.skip() and test.only() calls with any quote", () => {
  const ts = 'import { test } from "x";\n\ntest("a (1)", async () => {});\ntest.skip(\'b\', () => {});\ntest.only(`c`, () => {});\n';
  assert.equal(findTestLine(ts, "a (1)", "typescript"), 3);
  assert.equal(findTestLine(ts, "b", "typescript"), 4);
  assert.equal(findTestLine(ts, "c", "typescript"), 5);
  assert.equal(findTestLine(ts, "a", "typescript"), undefined);
});
