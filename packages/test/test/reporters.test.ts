import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunSummary, TestAttempt } from "@uefn-devtools/protocol";
import {
  createReporters,
  renderGithubLog,
  escapeData,
  escapeProperty,
  escapeXml,
  parseReporterNames,
  renderAnnotations,
  renderJunit,
  renderMarkdown,
} from "@uefn-devtools/test";

const attempt = (over: Partial<TestAttempt> = {}): TestAttempt => ({
  iteration: 0,
  status: "passed",
  durationMs: 1500,
  steps: [],
  assertions: [],
  eventCounts: {},
  ...over,
});

const failed = (iteration: number, artifactDir: string): TestAttempt =>
  attempt({
    iteration,
    status: "failed",
    durationMs: 2000,
    assertions: [{ description: "score is 50 | exact", passed: false, expected: 50, received: 100, timestamp: 1 }],
    failedStage: "ASSERTING",
    artifactDir,
  });

const SUMMARY: RunSummary = {
  runId: "run-1",
  status: "failed",
  startedAt: 0,
  durationMs: 12345,
  artifactDir: ".devtools/results/run-1",
  tests: [
    {
      id: "a",
      name: 'Capture <A> & "B"',
      file: "Tests/a.test.yaml",
      status: "passed",
      attempts: [attempt()],
      passed: 1,
      failed: 0,
      reliability: 1,
      correlations: [],
    },
    {
      id: "b",
      name: "Flaky",
      file: "Tests/b.test.ts",
      status: "failed",
      attempts: [attempt({ iteration: 0 }), failed(1, ".devtools/results/run-1/b-2"), attempt({ iteration: 2 }), attempt({ iteration: 3 })],
      passed: 3,
      failed: 1,
      reliability: 0.75,
      correlations: [{ description: "double award: 100% of failing runs", failingRuns: 1, passingRuns: 0 }],
    },
    {
      id: "c",
      name: "Skipped",
      file: "Tests/c.test.ts",
      status: "skipped",
      attempts: [],
      passed: 0,
      failed: 0,
      reliability: 1,
      correlations: [],
    },
  ],
};

test("xml escaping covers markup characters and drops control characters", () => {
  assert.equal(escapeXml(`<a href="x">&'\u0001ok`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;ok");
});

test("junit output is exact and deterministic", () => {
  const xml = renderJunit(SUMMARY);
  assert.equal(xml, renderJunit(SUMMARY));
  assert.equal(
    xml,
    `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="uefn-devtools" tests="6" failures="1" errors="0" skipped="1" time="12.345">
  <testsuite name="Capture &lt;A&gt; &amp; &quot;B&quot;" tests="1" failures="0" errors="0" skipped="0" time="1.500">
    <properties>
      <property name="file" value="Tests/a.test.yaml"/>
      <property name="reliability" value="1"/>
      <property name="attempts" value="1"/>
      <property name="passed" value="1"/>
      <property name="failed" value="0"/>
    </properties>
    <testcase name="Capture &lt;A&gt; &amp; &quot;B&quot;" classname="Tests/a.test.yaml" time="1.500"/>
  </testsuite>
  <testsuite name="Flaky" tests="4" failures="1" errors="0" skipped="0" time="6.500">
    <properties>
      <property name="file" value="Tests/b.test.ts"/>
      <property name="reliability" value="0.75"/>
      <property name="attempts" value="4"/>
      <property name="passed" value="3"/>
      <property name="failed" value="1"/>
      <property name="correlation" value="double award: 100% of failing runs"/>
    </properties>
    <testcase name="Flaky #1" classname="Tests/b.test.ts" time="1.500"/>
    <testcase name="Flaky #2" classname="Tests/b.test.ts" time="2.000">
      <failure message="expected 50, received 100" type="ASSERTING">Failed: score is 50 | exact
expected 50, received 100
Failed stage: ASSERTING
Artifacts: .devtools/results/run-1/b-2</failure>
      <system-out>FAIL assert: score is 50 | exact</system-out>
    </testcase>
    <testcase name="Flaky #3" classname="Tests/b.test.ts" time="1.500"/>
    <testcase name="Flaky #4" classname="Tests/b.test.ts" time="1.500"/>
  </testsuite>
  <testsuite name="Skipped" tests="1" failures="0" errors="0" skipped="1" time="0.000">
    <properties>
      <property name="file" value="Tests/c.test.ts"/>
      <property name="reliability" value="1"/>
      <property name="attempts" value="0"/>
      <property name="passed" value="0"/>
      <property name="failed" value="0"/>
    </properties>
    <testcase name="Skipped" classname="Tests/c.test.ts" time="0.000">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>
`,
  );
});

test("annotation escaping follows the workflow command rules", () => {
  assert.equal(escapeData("100%\r\nnext"), "100%25%0D%0Anext");
  assert.equal(escapeProperty("a:b,c%\n"), "a%3Ab%2Cc%25%0A");
  const lines = renderAnnotations({
    ...SUMMARY,
    tests: [{ ...SUMMARY.tests[1]!, name: "x: y, z", file: "Tests/we,ird.ts" }],
  });
  assert.equal(
    lines[0],
    "::error file=Tests/we%2Cird.ts,title=UEFN test failed%3A x%3A y%2C z::score is 50 | exact: expected 50, received 100 [stage ASSERTING] (1 of 4 attempts failed)",
  );
});

test("flaky tests produce a notice, solid failures do not", () => {
  const notices = renderAnnotations(SUMMARY).filter((l) => l.startsWith("::notice"));
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Flaky: passed 3 of 4 attempts \(reliability 75%25\)/);
  const hard = renderAnnotations({
    ...SUMMARY,
    tests: [{ ...SUMMARY.tests[1]!, passed: 0, failed: 1, reliability: 0, attempts: [failed(0, "d")] }],
  });
  assert.equal(hard.filter((l) => l.startsWith("::notice")).length, 0);
});

test("markdown summary has a table with reliability and artifacts, and escapes pipes", () => {
  const md = renderMarkdown(SUMMARY, { runUrl: "https://example.test/run/1", marker: true });
  assert.ok(md.startsWith("<!-- uefn-devtools-summary -->\n## ✗ UEFN DevTools: failed"));
  assert.match(md, /\| Test \| Status \| Reliability \| Duration \| Correlations \| Artifacts \|/);
  assert.match(md, /\| Flaky \| ✗ failed \(flaky\) \| 75% \(3\/4\) \| 6\.50s \| double award: 100% of failing runs \| `\.devtools\/results\/run-1\/b-2` \|/);
  assert.match(md, /\| Capture <A> & "B" \| ✓ passed \| 100% \|/);
  assert.match(md, /score is 50 \| exact: expected 50, received 100 \(stage ASSERTING\)/);
  assert.match(md, /\[workflow run\]\(https:\/\/example\.test\/run\/1\)/);
});

test("reporter selection parses lists, auto-adds github, and writes junit", async () => {
  assert.deepEqual(parseReporterNames(["github,junit", "console"]), ["github", "junit", "console"]);
  assert.throws(() => parseReporterNames(["nope"]), /unknown reporter/);
  const root = await mkdtemp(join(tmpdir(), "uefn-reporters-"));
  const out: string[] = [];
  const onEvent = createReporters({
    reporters: ["junit"],
    env: { GITHUB_ACTIONS: "true" },
    write: (t) => out.push(t),
    root,
  });
  onEvent({ kind: "done", summary: SUMMARY });
  assert.equal(await readFile(join(root, ".devtools/results/junit.xml"), "utf8"), renderJunit(SUMMARY));
  assert.ok(out.some((l) => l.startsWith("::error ")), "github reporter was added");
});

test("github log keeps untrusted text inside a stop-commands region", () => {
  const evil = "boom\n::error file=x::injected\n::add-mask::secret";
  const summary: RunSummary = {
    ...SUMMARY,
    tests: [
      {
        ...SUMMARY.tests[1]!,
        file: "Tests/evil\n::warning::file.ts",
        attempts: [attempt({ iteration: 0, status: "failed", error: evil, failedStage: "ASSERTING", steps: [] })],
        correlations: [{ description: "x\n::notice::corr", failingRuns: 1, passingRuns: 0 }],
      },
    ],
  };
  const lines = renderGithubLog(summary).join("\n").split("\n");
  const start = lines.findIndex((l) => l.startsWith("::stop-commands::"));
  assert.ok(start > 0, "stop-commands emitted");
  const token = lines[start]!.slice("::stop-commands::".length);
  assert.match(token, /^[0-9a-f-]{16,}$/);
  const end = lines.indexOf(`::${token}::`);
  assert.ok(end > start);
  for (const injected of ["::error file=x::injected", "::add-mask::secret", "::warning::file.ts", "::notice::corr"]) {
    const i = lines.indexOf(injected);
    assert.ok(i > start && i < end, `${injected} must be inside the stopped region`);
  }
  assert.ok(lines.indexOf("::endgroup::") > end, "endgroup is outside the stopped region");
  assert.ok(lines.findIndex((l) => l.startsWith("::group::")) < start);
});

test("stdoutJson keeps stdout clean and skips the json reporter", async () => {
  const root = await mkdtemp(join(tmpdir(), "uefn-reporters-"));
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = ((t: string) => (out.push(String(t)), true)) as typeof process.stdout.write;
  process.stderr.write = ((t: string) => (err.push(String(t)), true)) as typeof process.stderr.write;
  try {
    createReporters({ reporters: ["junit,github,json"], env: { GITHUB_ACTIONS: "true" }, root, stdoutJson: true })({
      kind: "done",
      summary: SUMMARY,
    });
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  assert.equal(out.join(""), "");
  assert.ok(err.join("").includes("JUnit:"));
  assert.ok(err.join("").includes("::error "));
  assert.ok(!err.join("").includes('"runId"'), "json reporter skipped");
});

test("one failing reporter does not stop the others", async () => {
  const root = await mkdtemp(join(tmpdir(), "uefn-reporters-"));
  await writeFile(join(root, "file"), "x");
  const out: string[] = [];
  const err: string[] = [];
  let handler: ReturnType<typeof createReporters> | undefined;
  const realErr = process.stderr.write;
  process.stderr.write = ((t: string) => (err.push(String(t)), true)) as typeof process.stderr.write;
  try {
    // junit cannot create a directory under a regular file, so it throws.
    const onEvent = createReporters({
      reporters: ["junit", "github"],
      output: join("file", "junit.xml"),
      write: (t) => out.push(t),
      root,
    });
    assert.doesNotThrow(() => onEvent({ kind: "done", summary: SUMMARY }));
    handler = onEvent;
  } finally {
    process.stderr.write = realErr;
  }
  assert.ok(err.join("").includes("reporter failed"));
  assert.ok(out.some((l) => l.startsWith("::error ")), "github reporter still ran");
  assert.equal(handler?.failures.length, 1);
});
