import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeFailure, killCommand, parseJsonOutput, resolveCli, runCli, shellSafeArgs } from "../dist/cli.js";

const only = (...files: string[]) => (f: string) => files.includes(f);

test("an explicit setting wins; relative paths resolve against the root, .js runs through node", () => {
  assert.deepEqual(resolveCli({ configured: "./tools/uefn.js", root: "/p", platform: "linux", exists: () => false }), {
    command: "node",
    args: ["/p/tools/uefn.js"],
    source: "setting",
  });
  assert.deepEqual(resolveCli({ configured: "/opt/bin/uefn", root: "/p", platform: "linux", exists: () => false }), {
    command: "/opt/bin/uefn",
    args: [],
    source: "setting",
  });
  assert.equal(resolveCli({ configured: "my-uefn", root: "/p", platform: "linux" }).command, "my-uefn");
});

test("finds node_modules/.bin/uefn in the root or an ancestor before PATH", () => {
  assert.equal(
    resolveCli({ root: "/w/examples/a", platform: "linux", pathEnv: "/usr/bin", exists: only("/w/node_modules/.bin/uefn", "/usr/bin/uefn") }).command,
    "/w/node_modules/.bin/uefn",
  );
});

test("falls back to the CLI package entry point when pnpm skipped the bin link", () => {
  const cli = resolveCli({ root: "/w/a", platform: "linux", exists: only("/w/a/node_modules/@uefn-devtools/cli/dist/main.js") });
  assert.deepEqual(cli, { command: "node", args: ["/w/a/node_modules/@uefn-devtools/cli/dist/main.js"], source: "workspace" });
});

test("searches PATH, then falls back to the bare name", () => {
  assert.deepEqual(resolveCli({ root: "/w", platform: "linux", pathEnv: "/a:/b", exists: only("/b/uefn") }), {
    command: "/b/uefn",
    args: [],
    source: "path",
  });
  assert.equal(resolveCli({ root: "/w", platform: "linux", pathEnv: "", exists: () => false }).source, "fallback");
});

test("uses .cmd shims through a shell on Windows", () => {
  const cli = resolveCli({ root: "C:\\w", platform: "win32", pathEnv: "", exists: only("C:\\w\\node_modules\\.bin\\uefn.cmd") });
  assert.deepEqual(cli, { command: "C:\\w\\node_modules\\.bin\\uefn.cmd", args: [], source: "workspace", shell: true });
});

test("parseJsonOutput takes the summary after noisy test output", () => {
  const summary = JSON.stringify({ status: "passed", tests: [{ id: "a" }] }, null, 2);
  const noisy = `{ x: 1 }\n{\n  "logged": true\n}\nsome text {\n${summary}\n`;
  assert.deepEqual(parseJsonOutput(noisy), { status: "passed", tests: [{ id: "a" }] });
});

test("killCommand kills the process tree with taskkill on Windows only", () => {
  assert.deepEqual(killCommand("win32", 42), { command: "taskkill", args: ["/pid", "42", "/T", "/F"] });
  assert.equal(killCommand("linux", 42), undefined);
  assert.equal(killCommand("darwin", 42), undefined);
  assert.equal(killCommand("win32", undefined), undefined);
});

test("parseJsonOutput tolerates leading noise and rejects non-JSON", () => {
  assert.deepEqual(parseJsonOutput('warn\n{"a":1}\n'), { a: 1 });
  assert.equal(parseJsonOutput("nope"), undefined);
});

test("runCli collects output and exit code; abort kills the process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uefn-vscode-"));
  const script = join(dir, "fake.js");
  await writeFile(script, `if (process.argv[2] === "hang") setInterval(() => {}, 1000); else { console.log(JSON.stringify({ args: process.argv.slice(2) })); console.error("progress"); process.exit(1); }`);
  const cli = { command: process.execPath, args: [script], source: "setting" as const };
  let streamed = "";
  const done = await runCli(cli, ["test", "x", "--json"], { cwd: dir, onStderr: (t) => (streamed += t) });
  assert.equal(done.code, 1);
  assert.deepEqual(parseJsonOutput(done.stdout), { args: ["test", "x", "--json"] });
  assert.equal(streamed.trim(), "progress");
  assert.match(describeFailure(cli, ["test"], done), /exited with code 1: progress/);

  const abort = new AbortController();
  const pending = runCli(cli, ["hang"], { cwd: dir, signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  const killed = await pending;
  assert.equal(killed.cancelled, true);
  assert.notEqual(killed.code, 0);
});

test("a missing binary reports a readable error", async () => {
  const cli = { command: "uefn-definitely-missing-binary", args: [], source: "fallback" as const };
  const result = await runCli(cli, ["list"], { cwd: tmpdir() });
  assert.ok(result.spawnError);
  assert.match(describeFailure(cli, ["list"], result), /Could not find the uefn CLI/);
});

test("shell-safe args quote spaces and refuse cmd.exe metacharacters", () => {
  assert.deepEqual(shellSafeArgs(["test", "capture-point-a", "--json", "C:\\a b\\x.yaml"]), [
    "test",
    "capture-point-a",
    "--json",
    '"C:\\a b\\x.yaml"',
  ]);
  for (const bad of ["a&calc", "x|y", 'q"uote', "%PATH%", "a^b", "<in", "line\nbreak"]) {
    assert.throws(() => shellSafeArgs([bad]), /refusing to pass/);
  }
});
