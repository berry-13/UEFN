import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runDoctor, type DoctorReport } from "@uefn-devtools/core";
import { loadTests } from "@uefn-devtools/test";

const EXAMPLE = resolve(import.meta.dirname, "../../../examples/capture-point");
const CLI = resolve(import.meta.dirname, "../../../apps/cli/dist/main.js");

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "uefn-devtools-doctor-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const status = (report: DoctorReport, id: string) => report.checks.find((c) => c.id === id);

const VALID_TEST = "name: Touch A\nsteps:\n  - teleport: { player: p1, location: A }\nassert:\n  - device: { id: A, state: Captured }\n";
const CONFIG = "simulated:\n  devices:\n    - id: A\n";

test("example project is healthy on the simulated adapter", async () => {
  const report = await runDoctor(undefined, { cwd: EXAMPLE, loadTests });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status === "fail")));
  assert.equal(status(report, "simulated.refs")?.status, "pass");
  assert.equal(status(report, "mcp.connect")?.status, "skip");
  assert.equal(status(report, "tests.discover")?.status, "pass");
});

test("a healthy temp project passes, and every failing check carries a fix", async () => {
  const dir = await project({
    "uefn-devtools.config.yaml": CONFIG,
    "Verse/a.verse": "a := class(creative_device){}\n",
    "Tests/a.test.yaml": VALID_TEST,
  });
  const ok = await runDoctor(undefined, { cwd: dir, loadTests });
  assert.equal(ok.ok, true);

  const bad = await project({
    "uefn-devtools.config.yaml": CONFIG,
    "Tests/a.test.yaml": VALID_TEST.replace("id: A", "id: Missing"),
    "Tests/b.test.yaml": VALID_TEST,
    "Tests/broken.test.yaml": "name: Broken\nsteps:\n  - bogus_step: {}\n",
  });
  const report = await runDoctor(undefined, { cwd: bad, loadTests });
  assert.equal(report.ok, false);
  assert.equal(status(report, "paths.verse")?.status, "fail");
  assert.equal(status(report, "tests.discover")?.status, "fail");
  assert.match(status(report, "tests.discover")!.detail, /broken\.test\.yaml/);
  assert.equal(status(report, "tests.ids")?.status, "fail");
  assert.match(status(report, "tests.ids")!.detail, /touch-a/);
  assert.equal(status(report, "simulated.refs")?.status, "fail");
  assert.match(status(report, "simulated.refs")!.detail, /'Missing'/);
  for (const c of report.checks) if (c.status === "fail") assert.ok(c.fix, `${c.id} has no fix`);
});

test("an invalid config is a failed check, not an exception", async () => {
  const dir = await project({ "uefn-devtools.config.yaml": "adapter: banana\n" });
  const report = await runDoctor(undefined, { cwd: dir });
  assert.equal(report.ok, false);
  assert.match(status(report, "config.valid")!.detail, /adapter/);
  assert.ok(status(report, "config.valid")!.fix);
});

test("old Node versions fail", async () => {
  const report = await runDoctor(undefined, { cwd: EXAMPLE, nodeVersion: "20.1.0" });
  assert.equal(status(report, "node.version")?.status, "fail");
});

test("daemon.json is stale when its pid is dead", async () => {
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  const stale = await project({
    "uefn-devtools.config.yaml": CONFIG,
    ".devtools/daemon.json": JSON.stringify({ pid: dead, port: 4000 }),
  });
  assert.equal(status(await runDoctor(undefined, { cwd: stale }), "daemon.stale")?.status, "warn");

  const live = await project({
    "uefn-devtools.config.yaml": CONFIG,
    ".devtools/daemon.json": JSON.stringify({ pid: process.pid, port: 4000 }),
  });
  assert.equal(status(await runDoctor(undefined, { cwd: live }), "daemon.stale")?.status, "pass");

  const junk = await project({ "uefn-devtools.config.yaml": CONFIG, ".devtools/daemon.json": "{nope" });
  assert.equal(status(await runDoctor(undefined, { cwd: junk }), "daemon.stale")?.status, "warn");
});

test("mcp adapter without a server or runtime reports concrete fixes", async () => {
  const dir = await project({ "uefn-devtools.config.yaml": "adapter: mcp\n", "Verse/a.verse": "a := class(creative_device){}\n", "Tests/.keep": "" });
  const report = await runDoctor(undefined, { cwd: dir });
  for (const id of ["mcp.server", "mcp.tools", "runtime.log", "verse.runtime"]) {
    assert.equal(status(report, id)?.status, "fail", id);
    assert.ok(status(report, id)!.fix, id);
  }
  assert.equal(status(report, "mcp.connect")?.status, "skip");
});

test("mcp adapter connects and checks mapped tool names against the server", async () => {
  const dir = await project({
    "uefn-devtools.config.yaml": [
      "adapter: mcp",
      "mcp:",
      `  command: ${JSON.stringify(process.execPath)}`,
      `  args: [${JSON.stringify(CLI)}, mcp]`,
      "  tools:",
      "    compile: uefn_compile_verse",
      "    start_session: not_a_real_tool",
      "runtime:",
      "  log_path: ./logs/UEFN.log",
      "",
    ].join("\n"),
    "Verse/devtools.verse": "devtools_emitter<public> := class:\n    Hello<public>():void = {}\n",
    "Tests/.keep": "",
    "logs/.keep": "",
  });
  const report = await runDoctor(undefined, { cwd: dir, connect: true, connectTimeoutMs: 20_000 });
  assert.equal(status(report, "mcp.server")?.status, "pass");
  assert.equal(status(report, "mcp.connect")?.status, "pass", status(report, "mcp.connect")?.detail);
  assert.equal(status(report, "mcp.tool_names")?.status, "fail");
  assert.match(status(report, "mcp.tool_names")!.detail, /not_a_real_tool/);
  assert.match(status(report, "mcp.tool_names")!.detail, /uefn_compile_verse/);
  assert.equal(status(report, "runtime.log")?.status, "warn");
  assert.equal(status(report, "verse.runtime")?.status, "pass");
});

test("mcp connection failures are reported with a timeout guard", async () => {
  const dir = await project({
    "uefn-devtools.config.yaml": `adapter: mcp\nmcp:\n  command: ${JSON.stringify(process.execPath)}\n  args: ["-e", "setTimeout(() => {}, 3000)"]\n`,
    "Tests/.keep": "",
  });
  const started = Date.now();
  const report = await runDoctor(undefined, { cwd: dir, connect: true, connectTimeoutMs: 500 });
  assert.equal(status(report, "mcp.connect")?.status, "fail");
  assert.match(status(report, "mcp.connect")!.detail, /timed out/);
  assert.ok(Date.now() - started < 15_000);
});
