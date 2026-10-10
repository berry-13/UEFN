import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initGithubWorkflow, WORKFLOW_PATH, workflowTemplate } from "../src/commands/github-workflow.ts";

test("the template installs project dependencies, runs npx uefn and uploads hidden files", () => {
  const text = workflowTemplate();
  assert.match(text, /npm ci/);
  assert.match(text, /npx uefn test/);
  assert.doesNotMatch(text, /npm install --global/);
  assert.equal((text.match(/include-hidden-files: true/g) ?? []).length, 2);
});

test("initGithubWorkflow uploads the configured paths.results", async () => {
  const root = await mkdtemp(join(tmpdir(), "uefn-workflow-"));
  await writeFile(join(root, "uefn-devtools.config.yaml"), "paths:\n  results: ./out/results\n");
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await initGithubWorkflow(root), 0);
  } finally {
    console.log = log;
  }
  const text = await readFile(join(root, WORKFLOW_PATH), "utf8");
  assert.match(text, /path: out\/results/);
  assert.doesNotMatch(text, /\.devtools\/results/);
});
